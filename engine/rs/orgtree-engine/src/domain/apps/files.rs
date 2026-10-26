//! Bounded autonomous portability IO. No database handle or lock crosses IO.
//! Directory handles pin the checked path; final opens never follow links.
use std::{fs::{File,OpenOptions},io::{Read,Write},path::{Path,PathBuf}};
use anyhow::Result;
use serde_json::{json,Value};
use super::wire::BUNDLE_MAX;

struct Directory {path:PathBuf,_handles:Vec<File>}
#[nolog]
fn plain(meta:&std::fs::Metadata)->Result<()> {
    #[cfg(windows)] let linked={use std::os::windows::fs::MetadataExt;meta.file_attributes()&0x400!=0};
    #[cfg(not(windows))] let linked=meta.file_type().is_symlink();
    if linked{crate::refuse!(Forbidden,"app bundle paths cannot use links or reparse points");}Ok(())
}
#[nolog]
fn directory(path:&Path)->Result<Directory>{
    if !path.is_absolute(){crate::refuse!(BadRequest,"app file directory must be absolute");}
    let mut handles:Vec<File>=Vec::new();
    for part in path.ancestors().filter(|p|!p.as_os_str().is_empty()).collect::<Vec<_>>().into_iter().rev(){
        let meta=std::fs::symlink_metadata(part)?;plain(&meta)?;
        if !meta.is_dir(){crate::refuse!(BadRequest,"app bundle parent is not a directory");}
        #[cfg(windows)] let file={
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::*;
            OpenOptions::new().read(true).share_mode(FILE_SHARE_READ|FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_OPEN_NO_RECALL).open(part)?
        };
        #[cfg(unix)] let file={
            use std::{ffi::CString,os::{fd::{AsRawFd,FromRawFd},unix::{ffi::OsStrExt,fs::OpenOptionsExt}}};
            if let Some(parent)=handles.last(){
                let name=CString::new(part.file_name().ok_or_else(||anyhow::anyhow!("invalid app directory"))?.as_bytes())?;
                let fd=unsafe{libc::openat(parent.as_raw_fd(),name.as_ptr(),libc::O_RDONLY|libc::O_DIRECTORY|libc::O_NOFOLLOW|libc::O_CLOEXEC|libc::O_NONBLOCK)};
                if fd<0{return Err(std::io::Error::last_os_error().into());}unsafe{File::from_raw_fd(fd)}
            }else{OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY|libc::O_NOFOLLOW|libc::O_CLOEXEC|libc::O_NONBLOCK).open(part)?}
        };
        #[cfg(not(any(windows,unix)))] let file=File::open(part)?;
        plain(&file.metadata()?)?;if !file.metadata()?.is_dir(){crate::refuse!(BadRequest,"app bundle parent changed");}
        handles.push(file);
    }
    Ok(Directory{path:path.to_path_buf(),_handles:handles})
}
impl Directory {
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
        let meta=file.metadata()?;plain(&meta)?;if !meta.is_file(){crate::refuse!(BadRequest,"app bundle must be a regular file");}Ok(file)
    }
}

#[nolog]
pub fn read(p:&crate::domain::docs::Presenter,raw:&str)->Result<Value>{
    let path=crate::domain::docs::readable(p,raw)?;
    let dir=directory(path.parent().ok_or_else(||anyhow::anyhow!("app file has no parent"))?)?;
    let file=dir.open(path.file_name().ok_or_else(||anyhow::anyhow!("app file has no name"))?,false)?;
    if file.metadata()?.len()>BUNDLE_MAX as u64{crate::refuse!(BadRequest,"app bundle exceeds16MiB");}
    let mut bytes=Vec::new();file.take(BUNDLE_MAX as u64+1).read_to_end(&mut bytes)?;
    if bytes.len()>BUNDLE_MAX{crate::refuse!(BadRequest,"app bundle exceeds16MiB");}
    serde_json::from_slice(&bytes).map_err(|_|crate::domain::UserError::BadRequest("invalid app bundle JSON".into()).into())
}
#[nolog]
pub fn write(scratch:&Path,bundle:&Value)->Result<Value>{
    use sha2::{Digest,Sha256};
    let bytes=serde_json::to_vec(bundle)?;if bytes.len()>BUNDLE_MAX{crate::refuse!(BadRequest,"app bundle exceeds16MiB");}
    // Only a fresh fixed-suffix file in the agent's existing private scratch.
    // Windows ancestor handles omit DELETE sharing; Unix uses openat on the
    // checked directory. No arbitrary destination or overwrite is accepted.
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
