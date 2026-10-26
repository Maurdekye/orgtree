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

// A relative NT open never re-resolves an absolute ancestor path. Attribute
// writes are not excluded by Win32 share flags, so pins alone are insufficient.
#[cfg(windows)]
#[nolog]
fn anchored(parent:&File,name:&std::ffi::OsStr,is_dir:bool,write:bool)->Result<File>{
    use std::{ffi::c_void,os::windows::{ffi::OsStrExt,io::{AsRawHandle,FromRawHandle}}};
    use windows_sys::Win32::{Foundation::HANDLE,Storage::FileSystem::*};
    #[repr(C)] struct Unicode {length:u16,maximum:u16,buffer:*mut u16}
    #[repr(C)] struct Attributes {length:u32,root:HANDLE,name:*mut Unicode,flags:u32,security:*mut c_void,quality:*mut c_void}
    #[repr(C)] struct IoStatus {status:usize,information:usize}
    #[link(name="ntdll")] unsafe extern "system" {
        fn NtCreateFile(handle:*mut HANDLE,access:u32,attributes:*const Attributes,io:*mut IoStatus,allocation:*const i64,file_attributes:u32,sharing:u32,disposition:u32,options:u32,ea:*const c_void,ea_length:u32)->i32;
        fn RtlNtStatusToDosError(status:i32)->u32;
    }
    let mut wide:Vec<u16>=name.encode_wide().collect();
    if wide.is_empty()||wide.len()>32760||wide.iter().any(|c|[0,47,92,58].contains(c))||name==std::ffi::OsStr::new(".")||name==std::ffi::OsStr::new(".."){crate::refuse!(Forbidden,"invalid anchored app file component");}
    let mut text=Unicode{length:(wide.len()*2) as u16,maximum:(wide.len()*2) as u16,buffer:wide.as_mut_ptr()};
    let attributes=Attributes{length:std::mem::size_of::<Attributes>() as u32,root:parent.as_raw_handle() as HANDLE,name:&mut text,flags:0x40|0x1000,security:std::ptr::null_mut(),quality:std::ptr::null_mut()}; // OBJ_CASE_INSENSITIVE|OBJ_DONT_REPARSE
    let mut handle=std::ptr::null_mut();let mut io=IoStatus{status:0,information:0};
    let access=FILE_READ_ATTRIBUTES|0x00100000|if write{FILE_WRITE_DATA}else{FILE_READ_DATA}; // SYNCHRONIZE
    let options=0x20|0x00200000|0x00400000|if is_dir{0x1}else{0x40}; // synchronous, open-reparse, no-recall, directory/non-directory
    let status=unsafe{NtCreateFile(&mut handle,access,&attributes,&mut io,std::ptr::null(),FILE_ATTRIBUTE_NORMAL,FILE_SHARE_READ,if write{2}else{1},options,std::ptr::null(),0)};
    if status<0{return Err(std::io::Error::from_raw_os_error(unsafe{RtlNtStatusToDosError(status)} as i32).into());}
    Ok(unsafe{File::from_raw_handle(handle as _)})
}

#[nolog]
fn open_directory_part(path:&Path,parent:Option<&File>)->Result<File>{
    #[cfg(windows)] let file={
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::*;
        // Deny data-write/delete sharing throughout IO. Attribute-only writes
        // need not conflict, so all descendants also use anchored NT opens.
        if let Some(parent)=parent{anchored(parent,path.file_name().ok_or_else(||anyhow::anyhow!("invalid app directory"))?,true,false)?}
        else{OpenOptions::new().read(true).share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_OPEN_NO_RECALL).open(path)?}
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
            anchored(self._handles.last().ok_or_else(||anyhow::anyhow!("missing checked directory"))?,name,false,write)?
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
        let writer=||OpenOptions::new().access_mode(FILE_WRITE_DATA|FILE_WRITE_ATTRIBUTES).share_mode(FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE).custom_flags(FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT).open(&root);
        let old=OpenOptions::new().read(true).share_mode(FILE_SHARE_READ|FILE_SHARE_WRITE).custom_flags(FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT).open(&root).unwrap();
        assert!(writer().is_ok(),"old-policy positive must admit the same data-write mutator");drop(old);
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
