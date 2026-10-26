//! Bounded autonomous portability IO. No database handle or lock crosses IO.
//! Authority is a lexical held root pinned without following original links.
use std::{fs::{File,OpenOptions},io::{Read,Write},path::{Path,PathBuf,Component}};
use anyhow::Result;
use serde_json::{json,Value};
use super::wire::BUNDLE_MAX;

struct Directory {path:PathBuf,_handles:Vec<File>}
#[nolog]
fn plain(meta:&std::fs::Metadata)->Result<()> {
    #[cfg(windows)] let linked={use std::os::windows::fs::MetadataExt;meta.file_attributes()&(0x400|0x1000|0x40000|0x400000)!=0};
    #[cfg(not(windows))] let linked=meta.file_type().is_symlink();
    if linked{crate::refuse!(Forbidden,"app bundle paths cannot use links or reparse points");}Ok(())
}
#[nolog]
fn checked_path(path:&Path)->Result<PathBuf>{
    let path=crate::config::strip_verbatim(path);
    if !path.is_absolute()||path.components().any(|c|matches!(c,Component::ParentDir)) {crate::refuse!(Forbidden,"app file paths must be absolute without parent components");}
    #[cfg(windows)] if !matches!(path.components().next(),Some(Component::Prefix(p)) if matches!(p.kind(),std::path::Prefix::Disk(_)|std::path::Prefix::UNC(_,_))){crate::refuse!(Forbidden,"unsupported app file path prefix");}
    Ok(path)
}
#[cfg(windows)]
#[nolog]
fn verify(file:&File,expected:&Path)->Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::*;
    let handle=file.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
    if unsafe{GetFileType(handle)}!=FILE_TYPE_DISK{crate::refuse!(Forbidden,"app bundle path is not a disk file");}
    let mut buffer=vec![0u16;512];
    loop {
        let n=unsafe{GetFinalPathNameByHandleW(handle,buffer.as_mut_ptr(),buffer.len() as u32,FILE_NAME_NORMALIZED|VOLUME_NAME_DOS)} as usize;
        if n==0{return Err(std::io::Error::last_os_error().into());}
        if n>=buffer.len(){if n>=32768{crate::refuse!(Forbidden,"app file path is too long");}buffer.resize(n+1,0);continue;}
        let actual=PathBuf::from(String::from_utf16(&buffer[..n])?);
        let norm=|p:&Path|crate::config::strip_verbatim(p).to_string_lossy().replace('/',"\\").trim_end_matches('\\').to_string();
        if !norm(&actual).eq_ignore_ascii_case(&norm(expected)){crate::refuse!(Forbidden,"opened app file path differs from its pinned path");}return Ok(());
    }
}
#[cfg(not(windows))] #[nolog] fn verify(_file:&File,_expected:&Path)->Result<()>{Ok(())}

#[nolog]
fn open_directory_part(path:&Path,parent:Option<&File>)->Result<File>{
    #[cfg(windows)] let file={
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::*;
        // Deny BOTH write and delete sharing for the whole traversal/IO. A
        // pre-existing write-capable handle also makes this open fail closed.
        OpenOptions::new().read(true).share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_OPEN_NO_RECALL).open(path)?
    };
    #[cfg(unix)] let file={
        use std::{ffi::CString,os::{fd::{AsRawFd,FromRawFd},unix::{ffi::OsStrExt,fs::OpenOptionsExt}}};
        let flags=libc::O_RDONLY|libc::O_DIRECTORY|libc::O_NOFOLLOW|libc::O_CLOEXEC|libc::O_NONBLOCK;
        if let Some(parent)=parent{
            let name=CString::new(path.file_name().ok_or_else(||anyhow::anyhow!("invalid app directory"))?.as_bytes())?;
            let fd=unsafe{libc::openat(parent.as_raw_fd(),name.as_ptr(),flags)};
            if fd<0{return Err(std::io::Error::last_os_error().into());}unsafe{File::from_raw_fd(fd)}
        }else{OpenOptions::new().read(true).custom_flags(flags).open(path)?}
    };
    #[cfg(not(any(windows,unix)))] let file=File::open(path)?;
    #[cfg(not(unix))] let _=parent;
    let meta=file.metadata()?;plain(&meta)?;if !meta.is_dir(){crate::refuse!(Forbidden,"app bundle parent is not a directory");}
    verify(&file,path)?;Ok(file)
}
#[nolog]
fn directory(path:&Path)->Result<Directory>{
    let path=checked_path(path)?;let mut handles:Vec<File>=Vec::new();
    for part in path.ancestors().filter(|p|!p.as_os_str().is_empty()).collect::<Vec<_>>().into_iter().rev(){handles.push(open_directory_part(part,handles.last())?);}
    Ok(Directory{path,_handles:handles})
}
impl Directory {
    #[nolog]
    fn descend(mut self,relative:&Path)->Result<Self>{
        for component in relative.components(){let Component::Normal(name)=component else{crate::refuse!(Forbidden,"invalid relative app file path");};
            self.path.push(name);self._handles.push(open_directory_part(&self.path,self._handles.last())?);
        }Ok(self)
    }
    #[nolog]
    fn open(&self,name:&std::ffi::OsStr,write:bool)->Result<File>{
        #[cfg(windows)] let file={
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::*;
            let mut options=OpenOptions::new();options.read(!write).write(write).create_new(write)
                .share_mode(FILE_SHARE_READ).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_OPEN_NO_RECALL);
            options.open(self.path.join(name))?
        };
        #[cfg(unix)] let file={
            use std::{ffi::CString,os::{fd::{AsRawFd,FromRawFd},unix::ffi::OsStrExt}};
            let name=CString::new(name.as_bytes())?;let flags=libc::O_NOFOLLOW|libc::O_CLOEXEC|libc::O_NONBLOCK|if write{libc::O_WRONLY|libc::O_CREAT|libc::O_EXCL}else{libc::O_RDONLY};
            let fd=unsafe{libc::openat(self._handles.last().ok_or_else(||anyhow::anyhow!("missing checked directory"))?.as_raw_fd(),name.as_ptr(),flags,0o600)};
            if fd<0{return Err(std::io::Error::last_os_error().into());}unsafe{File::from_raw_fd(fd)}
        };
        #[cfg(not(any(windows,unix)))] let file=OpenOptions::new().read(!write).write(write).create_new(write).open(self.path.join(name))?;
        let meta=file.metadata()?;plain(&meta)?;if !meta.is_file(){crate::refuse!(BadRequest,"app bundle must be a regular file");}verify(&file,&self.path.join(name))?;Ok(file)
    }
}
#[nolog]
fn relative(path:&Path,root:&Path)->Option<PathBuf>{
    let p:Vec<_>=path.components().collect();let r:Vec<_>=root.components().collect();
    if p.len()<=r.len(){return None;}
    let equal=|a:Component<'_>,b:Component<'_>|{
        #[cfg(windows)] {a.as_os_str().to_string_lossy().eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())}
        #[cfg(not(windows))] {a==b}
    };
    if !p.iter().zip(&r).all(|(a,b)|equal(*a,*b)){return None;}Some(p[r.len()..].iter().map(|c|c.as_os_str()).collect())
}
#[nolog]
pub fn read(p:&crate::domain::docs::Presenter,raw:&str)->Result<Value>{
    let path=checked_path(Path::new(raw))?;let mut selected=None;
    for raw_root in std::iter::once(p.scratch.clone()).chain(p.dirs.iter().map(PathBuf::from)){
        let root=checked_path(&raw_root)?;
        if let Some(suffix)=relative(&path,&root){selected=Some((directory(&root)?,suffix));break;}
    }
    let Some((scope,suffix))=selected else{crate::refuse!(Forbidden,"app bundle is outside your held folders");};
    let dir=scope.descend(suffix.parent().unwrap_or_else(||Path::new("")))?;
    let file=dir.open(suffix.file_name().ok_or_else(||anyhow::anyhow!("app file has no name"))?,false)?;
    if file.metadata()?.len()>BUNDLE_MAX as u64{crate::refuse!(BadRequest,"app bundle exceeds16MiB");}
    let mut bytes=Vec::new();file.take(BUNDLE_MAX as u64+1).read_to_end(&mut bytes)?;
    if bytes.len()>BUNDLE_MAX{crate::refuse!(BadRequest,"app bundle exceeds16MiB");}
    serde_json::from_slice(&bytes).map_err(|_|crate::domain::UserError::BadRequest("invalid app bundle JSON".into()).into())
}
#[nolog]
pub fn write(scratch:&Path,bundle:&Value)->Result<Value>{
    use sha2::{Digest,Sha256};
    let bytes=serde_json::to_vec(bundle)?;if bytes.len()>BUNDLE_MAX{crate::refuse!(BadRequest,"app bundle exceeds16MiB");}
    let dir=directory(scratch)?;let name=format!("{}.orgtree-app",crate::util::uid("app-export"));
    let mut file=dir.open(std::ffi::OsStr::new(&name),true)?;file.write_all(&bytes)?;file.sync_all()?;
    Ok(json!({"path":dir.path.join(name).to_string_lossy(),"bytes":bytes.len(),"sha256":hex::encode(Sha256::digest(&bytes)),"format":"orgtree-app","version":1}))
}

#[cfg(test)] mod tests{
    use super::*;
    #[cfg(windows)]
    #[test] fn custom_apps_file_paths_refuse_original_junctions_and_retargeted_held_roots(){
        use std::process::Command;
        let root=std::env::temp_dir().join(crate::util::uid("apps-link-control"));std::fs::create_dir(&root).unwrap();
        let held=root.join("held");let unheld=root.join("unheld");std::fs::create_dir(&held).unwrap();std::fs::create_dir(&unheld).unwrap();
        let bundle=json!({"format":"orgtree-app","version":1,"definition":{"name":"x","html":"<p>x</p>"}});
        std::fs::write(held.join("app.json"),bundle.to_string()).unwrap();std::fs::write(unheld.join("app.json"),bundle.to_string()).unwrap();
        let link=held.join("shortcut");assert!(Command::new("cmd.exe").args(["/c","mklink","/J"]).arg(&link).arg(&held).output().unwrap().status.success());
        let p=crate::domain::docs::Presenter{id:1,name:"test".into(),may_present:false,scratch:held.clone(),dirs:vec![]};
        assert!(read(&p,held.join("app.json").to_str().unwrap()).is_ok(),"ordinary positive");
        assert!(read(&p,link.join("app.json").to_str().unwrap()).is_err(),"original in-scope junction must not disappear through canonicalization");
        let replaced=root.join("retargeted");assert!(Command::new("cmd.exe").args(["/c","mklink","/J"]).arg(&replaced).arg(&unheld).output().unwrap().status.success());
        let p=crate::domain::docs::Presenter{scratch:replaced.clone(),..p};assert!(read(&p,replaced.join("app.json").to_str().unwrap()).is_err(),"a held-root junction cannot transfer authority to its target");
    }
    #[cfg(windows)]
    #[test] fn custom_apps_windows_import_export_pins_exclude_directory_mutators(){
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::*;
        let root=std::env::temp_dir().join(crate::util::uid("apps-pin-control"));std::fs::create_dir(&root).unwrap();
        let writer=||OpenOptions::new().access_mode(FILE_WRITE_ATTRIBUTES).share_mode(FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE).custom_flags(FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT).open(&root);
        let pin=directory(&root).unwrap();assert!(writer().is_err(),"a live import/export pin must deny write-capable directory handles");drop(pin);
        let _writer=writer().unwrap();assert!(directory(&root).is_err(),"a pre-opened mutator must prevent authority pinning");
    }
    #[test] fn custom_apps_bundle_file_io_is_bounded_scoped_and_never_overwrites(){
        let root=std::env::temp_dir().join(crate::util::uid("apps-files-test"));std::fs::create_dir(&root).unwrap();
        let allowed=root.join("allowed");let outside=root.join("outside");std::fs::create_dir(&allowed).unwrap();std::fs::create_dir(&outside).unwrap();
        let p=crate::domain::docs::Presenter{id:1,name:"test".into(),may_present:false,scratch:allowed.clone(),dirs:vec![]};
        let value=json!({"format":"orgtree-app","version":1,"definition":{"name":"x","html":"<p>x</p>"}});
        let a=write(&allowed,&value).unwrap();let b=write(&allowed,&value).unwrap();assert_ne!(a["path"],b["path"]);
        assert_eq!(read(&p,a["path"].as_str().unwrap()).unwrap(),value);
        let forbidden=outside.join("app.json");std::fs::write(&forbidden,b"{}").unwrap();assert!(read(&p,forbidden.to_str().unwrap()).is_err());
        let huge=allowed.join("huge.orgtree-app");File::create(&huge).unwrap().set_len(BUNDLE_MAX as u64+1).unwrap();assert!(read(&p,huge.to_str().unwrap()).is_err());
    }
}
