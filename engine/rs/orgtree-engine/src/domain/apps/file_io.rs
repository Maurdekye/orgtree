//! Handle-relative directory enumeration and bounded, confirmed file changes.
//! This module never receives an unvalidated authority or owns a PG handle.
use super::*;
use std::ffi::OsStr;
use sha2::{Digest,Sha256};
use anyhow::Context;

pub(in crate::domain::apps) const WRITE_MAX:usize=64*1024;
pub(in crate::domain::apps) struct Entry {pub name:String,pub directory:bool}

/// The directory is opened once through no-reparse ancestors. Enumeration
/// uses that handle, never a second resolution of the original path.
#[nolog]
pub(in crate::domain::apps) fn list(path:&Path,after:Option<&str>,limit:usize)->Result<(Vec<Entry>,bool,bool)>{
    if !(1..=200).contains(&limit){crate::refuse!(BadRequest,"file listing limit must be 1-200");}
    let dir=directory(path)?;let mut entries=Vec::new();let mut scanned=0usize;let mut capped=false;
    #[cfg(windows)] {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Foundation::ERROR_NO_MORE_FILES,Storage::FileSystem::*};
        let mut buffer=vec![0u64;8192];let handle=dir._handles.last().expect("pinned directory").as_raw_handle() as _;
        'pages: loop {
            if unsafe{GetFileInformationByHandleEx(handle,FileIdBothDirectoryInfo,buffer.as_mut_ptr().cast(),(buffer.len()*8) as u32)}==0{
                let error=std::io::Error::last_os_error();if error.raw_os_error()==Some(ERROR_NO_MORE_FILES as i32){break;}return Err(error.into());
            }
            let bytes=buffer.len()*8;let mut at=0usize;
            loop {
                let head=std::mem::offset_of!(FILE_ID_BOTH_DIR_INFO,FileName);
                if at+head>bytes{crate::refuse!(BadRequest,"invalid directory record");}
                let item=unsafe{&*(buffer.as_ptr().cast::<u8>().add(at).cast::<FILE_ID_BOTH_DIR_INFO>())};
                let size=item.FileNameLength as usize;
                if size%2!=0||size>bytes-at-head{crate::refuse!(BadRequest,"invalid directory name");}
                let wide=unsafe{std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>().add(at+head).cast::<u16>(),size/2)};
                if let Ok(name)=String::from_utf16(wide){
                    scanned+=1;if scanned>20_000{capped=true;break 'pages;}
                    if name!="."&&name!=".."&&item.FileAttributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DEVICE|FILE_ATTRIBUTE_OFFLINE)==0&&after.is_none_or(|a|name.as_str()>a){entries.push(Entry{name,directory:item.FileAttributes&FILE_ATTRIBUTE_DIRECTORY!=0});}
                }
                let next=item.NextEntryOffset as usize;if next==0{break;}
                if next<head||next%8!=0||next>bytes-at{crate::refuse!(BadRequest,"invalid directory continuation");}at+=next;
            }
        }
    }
    #[cfg(unix)] {
        use std::{os::fd::AsRawFd,ffi::CStr};
        let fd=unsafe{libc::dup(dir._handles.last().expect("pinned directory").as_raw_fd())};if fd<0{return Err(std::io::Error::last_os_error().into());}
        let stream=unsafe{libc::fdopendir(fd)};if stream.is_null(){unsafe{libc::close(fd)};return Err(std::io::Error::last_os_error().into());}
        struct Close(*mut libc::DIR);impl Drop for Close{fn drop(&mut self){unsafe{libc::closedir(self.0)};}}let _close=Close(stream);
        loop{let item=unsafe{libc::readdir(stream)};if item.is_null(){break;}let item=unsafe{&*item};let Ok(name)=unsafe{CStr::from_ptr(item.d_name.as_ptr())}.to_str()else{continue;};
            scanned+=1;if scanned>20_000{capped=true;break;}if name=="."||name==".."||after.is_some_and(|a|name<=a)||![libc::DT_REG,libc::DT_DIR].contains(&item.d_type){continue;}
            entries.push(Entry{name:name.into(),directory:item.d_type==libc::DT_DIR});
        }
    }
    #[cfg(not(any(windows,unix)))] {let _=dir;crate::refuse!(Forbidden,"secure directory enumeration is unavailable on this platform");}
    entries.sort_by(|a,b|a.name.cmp(&b.name));let more=entries.len()>limit;entries.truncate(limit);Ok((entries,more,capped))
}

/// Kept only in the host's bounded 120-second confirmation registry. A target
/// handle excludes ordinary data writes/deletion while consent is pending.
pub(in crate::domain::apps) struct Change {dir:Directory,name:String,target:Option<File>,data:Option<Vec<u8>>,pub detail:Value}
#[nolog]
pub(in crate::domain::apps) fn prepare(path:&Path,data:Option<Vec<u8>>,replace:bool)->Result<Change>{
    if data.as_ref().is_some_and(|v|v.len()>WRITE_MAX){crate::refuse!(BadRequest,"file writes are limited to 65536 bytes");}
    let path=checked_path(path)?;let mut dir=directory(path.parent().ok_or_else(||anyhow::anyhow!("file has no parent"))?)?;
    if directory(&path).is_ok(){crate::refuse!(Forbidden,"only regular files can be changed; directory deletion is unavailable");}
    #[cfg(windows)] {
        // A rename needs directory-write sharing on its immediate parent.
        // Retain all ancestor pins and continue denying directory deletion;
        // reopen only this final component relative to its pinned ancestor.
        let previous=dir._handles.pop().expect("selected parent");drop(previous);
        let handle=if let Some(ancestor)=dir._handles.last(){
            anchored_shared(ancestor,dir.path.file_name().ok_or_else(||anyhow::anyhow!("invalid selected parent"))?,true,false,false,true)?
        }else{
            // A disk/share root has no relative ancestor to reopen from. This
            // is the same checked absolute root open used for read IO, with
            // write sharing (never delete sharing) for its child mutations.
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::*;
            OpenOptions::new().read(true).share_mode(FILE_SHARE_READ|FILE_SHARE_WRITE).custom_flags(FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_OPEN_NO_RECALL).open(&dir.path)?
        };
        plain(&handle.metadata()?)?;verify(&handle,&dir.path)?;dir._handles.push(handle);
    }
    let name=path.file_name().and_then(|s|s.to_str()).ok_or_else(||anyhow::anyhow!("file has no Unicode name"))?.to_string();
    // Reuse the component checker even for a name that does not exist yet.
    scoped_path(&dir.path,&name)?;
    #[cfg(windows)] let target=match anchored_access(dir._handles.last().expect("pinned directory"),OsStr::new(&name),false,false,true){
        Ok(file)=>{let meta=file.metadata()?;plain(&meta)?;if !meta.is_file(){crate::refuse!(Forbidden,"only regular files can be changed");}verify(&file,&path)?;Some(file)},
        Err(error) if error.downcast_ref::<std::io::Error>().is_some_and(|e|e.kind()==std::io::ErrorKind::NotFound)=>None,
        Err(error)=>return Err(error),
    };
    #[cfg(not(windows))] let target:Option<File>={crate::refuse!(Forbidden,"confirmed file changes require Windows in this release");};
    if target.is_some()&&data.is_some()&&!replace{crate::refuse!(Conflict,"file exists; replacement requires replace=true and native confirmation");}
    if target.is_none()&&data.is_none(){crate::refuse!(NotFound,"file to delete no longer exists");}
    let detail=json!({"path":path.to_string_lossy(),"operation":if data.is_none(){"delete"}else if target.is_some(){"replace"}else{"create"},"previous_bytes":target.as_ref().map(|f|f.metadata().map(|m|m.len())).transpose()?,"bytes":data.as_ref().map(Vec::len),"sha256":data.as_ref().map(|v|hex::encode(Sha256::digest(v)))});
    Ok(Change{dir,name,target,data,detail})
}
#[cfg(windows)]
#[nolog]
fn delete_handle(file:&File)->Result<()>{
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::*;
    let info=FILE_DISPOSITION_INFO{DeleteFile:1};
    if unsafe{SetFileInformationByHandle(file.as_raw_handle() as _,FileDispositionInfo,(&info as *const FILE_DISPOSITION_INFO).cast(),std::mem::size_of_val(&info) as u32)}==0{return Err(std::io::Error::last_os_error().into());}Ok(())
}
#[cfg(windows)]
#[nolog]
fn rename(file:&File,dir:&Directory,name:&str)->Result<()>{
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::*;
    use windows_sys::{Wdk::Storage::FileSystem::{NtSetInformationFile,FileRenameInformationEx},Win32::{Foundation::RtlNtStatusToDosError,System::IO::IO_STATUS_BLOCK}};
    let name:Vec<u16>=name.encode_utf16().collect();let offset=std::mem::offset_of!(FILE_RENAME_INFO,FileName);let size=offset+name.len()*2;
    let mut buffer=vec![0u64;size.div_ceil(8)];let info=buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe{(*info).Anonymous.Flags=0;(*info).RootDirectory=dir._handles.last().expect("pinned directory").as_raw_handle() as _;(*info).FileNameLength=(name.len()*2) as u32;std::ptr::copy_nonoverlapping(name.as_ptr(),buffer.as_mut_ptr().cast::<u8>().add(offset).cast(),name.len());}
    // Never overwrite an existing destination, even one created concurrently.
    // The Win32 wrapper rejects a non-null RootDirectory. The NT call keeps
    // this rename relative to the pinned parent instead of resolving a path.
    let mut io:IO_STATUS_BLOCK=unsafe{std::mem::zeroed()};
    let status=unsafe{NtSetInformationFile(file.as_raw_handle() as _,&mut io,buffer.as_ptr().cast(),size as u32,FileRenameInformationEx)};
    if status<0{return Err(std::io::Error::from_raw_os_error(unsafe{RtlNtStatusToDosError(status)} as i32).into());}Ok(())
}
/// The engine data folder that records replacements in progress.
pub(in crate::domain::apps) const RECOVERY:&str="app-file-recovery";
#[nolog]
pub(in crate::domain::apps) fn commit(change:Change,journal:&Path)->Result<Value>{
    commit_with(change,journal,||{})
}
#[nolog]
fn commit_with(change:Change,_journal:&Path,between:impl FnOnce())->Result<Value>{
    #[cfg(windows)] {
        let Change{dir,name,target,data,detail}=change;
        if let Some(old)=&target{verify(old,&dir.path.join(&name))?;}
        if let Some(data)=data{
            let staged_name=crate::util::uid(".orgtree-app-save");
            let mut stage=anchored_access(dir._handles.last().expect("pinned directory"),OsStr::new(&staged_name),false,true,true)?;
            let result=(||->Result<Value>{
                stage.write_all(&data).context("stage bytes")?;stage.sync_all().context("flush stage")?;
                if let Some(old)=&target{
                    // Keep the exclusive old-file pin. Windows cannot replace
                    // it in one rename without relaxing deletion sharing. Move
                    // that exact handle aside, then publish without overwrite.
                    let backup=crate::util::uid(".orgtree-app-recovery");rename(old,&dir,&backup).context("retain confirmed target")?;between();
                    if let Err(error)=rename(&stage,&dir,&name){
                        if rename(old,&dir,&name).is_err(){
                            return Ok(json!({"changed":false,"recovery_name":backup,"error":"Replacement conflicted. Original bytes remain in the recovery file; no existing destination was overwritten."}));
                        }return Err(error);
                    }
                    if delete_handle(old).is_err(){return Ok(json!({"changed":true,"operation":"replace","bytes":detail["bytes"],"sha256":detail["sha256"],"recovery_name":backup,"warning":"Saved, but the original recovery copy could not be removed."}));}
                }else{between();rename(&stage,&dir,&name)?;}
                Ok(json!({"changed":true,"operation":detail["operation"],"bytes":detail["bytes"],"sha256":detail["sha256"]}))
            })();
            match result{Ok(value)=>{if value["changed"]!=true{let _=delete_handle(&stage);}return Ok(value)},Err(error)=>{let _=delete_handle(&stage);return Err(error)}}
        }else{delete_handle(target.as_ref().expect("checked deletion target"))?;}
        Ok(json!({"changed":true,"operation":detail["operation"],"bytes":detail["bytes"],"sha256":detail["sha256"]}))
    }
    #[cfg(not(windows))] {let _=change;crate::refuse!(Forbidden,"confirmed file changes require Windows in this release");}
}
/// Settles the replacements a stop interrupted (4.5.0 review C12). Not yet:
/// this seam only lets the red test compile.
#[nolog]
pub(in crate::domain::apps) fn recover(_journal:&Path)->usize{0}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn app_files_directory_listing_and_confirmed_changes_are_bounded(){
        let dir=std::env::temp_dir().join(crate::util::uid("apps-write"));std::fs::create_dir(&dir).unwrap();std::fs::write(dir.join("old.txt"),b"old").unwrap();
        let journal=std::env::temp_dir().join(crate::util::uid("apps-journal"));
        assert_eq!(list(&dir,None,10).unwrap().0[0].name,"old.txt");assert!(list(&dir,None,201).is_err());
        #[cfg(windows)]{
            // Only prepare/drop: measure the root-directory handle branch
            // without writing anywhere outside the synthetic temp fixture.
            let root=dir.ancestors().last().unwrap();let untouched=root.join(crate::util::uid("app-unwritten-root-probe"));
            drop(prepare(&untouched,Some(b"not written".to_vec()),false).unwrap());assert!(!untouched.exists());
            assert!(prepare(&dir.join("old.txt"),Some(vec![0;WRITE_MAX+1]),true).is_err());assert!(prepare(&dir.join("old.txt"),Some(b"new".to_vec()),false).is_err());
            let change=prepare(&dir.join("old.txt"),Some(b"new".to_vec()),true).unwrap();assert!(std::fs::write(dir.join("old.txt"),b"raced").is_err());commit(change,&journal).unwrap();assert_eq!(std::fs::read(dir.join("old.txt")).unwrap(),b"new");
            commit(prepare(&dir.join("new.txt"),Some(b"created".to_vec()),false).unwrap(),&journal).unwrap();assert_eq!(std::fs::read(dir.join("new.txt")).unwrap(),b"created");
            let change=prepare(&dir.join("old.txt"),None,false).unwrap();commit(change,&journal).unwrap();assert!(!dir.join("old.txt").exists());
            std::fs::write(dir.join("conflict.txt"),b"original").unwrap();let change=prepare(&dir.join("conflict.txt"),Some(b"replacement".to_vec()),true).unwrap();
            let result=commit_with(change,&journal,||std::fs::write(dir.join("conflict.txt"),b"concurrent destination").unwrap()).unwrap();
            assert_eq!(result["changed"],false);assert_eq!(std::fs::read(dir.join("conflict.txt")).unwrap(),b"concurrent destination");
            assert_eq!(std::fs::read(dir.join(result["recovery_name"].as_str().unwrap())).unwrap(),b"original");
            // every change that ran to its end leaves no recovery record behind
            assert_eq!(std::fs::read_dir(&journal).map(|d|d.count()).unwrap_or(0),0);
        }
    }
    // 4.5.0 review C12 (alpha.2 1b8cf6b17672 F1): a stop after the original moved aside and before
    // the new bytes were published left the target missing and its original under an unrecorded
    // random name. The next start puts the original back and removes the staged copy.
    #[test]fn app_files_a_replacement_stopped_midway_is_restored_at_the_next_start(){
        #[cfg(windows)]{
            let dir=std::env::temp_dir().join(crate::util::uid("apps-stop"));std::fs::create_dir(&dir).unwrap();
            let journal=std::env::temp_dir().join(crate::util::uid("apps-journal"));std::fs::write(dir.join("keep.txt"),b"original").unwrap();
            let change=prepare(&dir.join("keep.txt"),Some(b"replacement".to_vec()),true).unwrap();
            let stop=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||commit_with(change,&journal,||panic!("synthetic engine stop between the two renames"))));
            assert!(stop.is_err());assert!(!dir.join("keep.txt").exists(),"the stop left the target missing");
            recover(&journal);
            assert_eq!(std::fs::read(dir.join("keep.txt")).ok().as_deref(),Some(&b"original"[..]),"the next start restores the original");
            let names:Vec<String>=std::fs::read_dir(&dir).unwrap().map(|e|e.unwrap().file_name().to_string_lossy().into_owned()).collect();
            assert_eq!(names,["keep.txt"],"no recovery or staged copy is left behind");
            assert_eq!(std::fs::read_dir(&journal).map(|d|d.count()).unwrap_or(0),0,"the record is settled");
            std::fs::remove_dir_all(&dir).unwrap();let _=std::fs::remove_dir_all(&journal);
        }
    }
}
