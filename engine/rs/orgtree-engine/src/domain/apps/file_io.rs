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
/// A file's parent for a change: every ancestor pinned, the parent itself
/// reopened with the directory-write sharing its renames need.
#[nolog]
fn writable_parent(parent:&Path)->Result<Directory>{
    let mut dir=directory(parent)?;
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
    Ok(dir)
}
#[nolog]
pub(in crate::domain::apps) fn prepare(path:&Path,data:Option<Vec<u8>>,replace:bool)->Result<Change>{
    if data.as_ref().is_some_and(|v|v.len()>WRITE_MAX){crate::refuse!(BadRequest,"file writes are limited to 65536 bytes");}
    let path=checked_path(path)?;let dir=writable_parent(path.parent().ok_or_else(||anyhow::anyhow!("file has no parent"))?)?;
    if directory(&path).is_ok(){crate::refuse!(Forbidden,"only regular files can be changed; directory deletion is unavailable");}
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
/// A replacement moves the confirmed original aside before it publishes the
/// staged bytes. Before anything is staged or moved, this record names both in
/// the engine's recovery folder, flushed, so a start after a stop can settle
/// the change (4.5.0 review C12). The change removes it when it ends.
#[derive(serde::Serialize,serde::Deserialize)]
struct Pending{directory:PathBuf,name:String,stage:String,backup:String,sha256:String}
#[cfg(windows)]
#[nolog]
fn record(journal:&Path,pending:&Pending)->Result<PathBuf>{
    std::fs::create_dir_all(journal).context("app file recovery folder")?;
    let path=journal.join(crate::util::uid("replace-")+".json");
    let mut file=OpenOptions::new().write(true).create_new(true).open(&path).context("create app file recovery record")?;
    file.write_all(&serde_json::to_vec(pending)?).context("write app file recovery record")?;file.sync_all().context("flush app file recovery record")?;Ok(path)
}
#[cfg(windows)]
#[nolog]
fn missing(error:&anyhow::Error)->bool{error.downcast_ref::<std::io::Error>().is_some_and(|e|e.kind()==std::io::ErrorKind::NotFound)}
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
fn commit_with(change:Change,journal:&Path,between:impl FnOnce())->Result<Value>{
    #[cfg(windows)] {
        let Change{dir,name,target,data,detail}=change;
        if let Some(old)=&target{verify(old,&dir.path.join(&name))?;}
        if let Some(data)=data{
            let staged_name=crate::util::uid(".orgtree-app-save");let backup=crate::util::uid(".orgtree-app-recovery");
            let pending=match &target{
                Some(_)=>Some(record(journal,&Pending{directory:dir.path.clone(),name:name.clone(),stage:staged_name.clone(),backup:backup.clone(),sha256:detail["sha256"].as_str().unwrap_or_default().into()})?),
                None=>None,
            };
            // Every outcome below is final, so its record goes; only a stop leaves it.
            let settled=||{if let Some(path)=&pending{let _=std::fs::remove_file(path);}};
            let mut stage=match anchored_access(dir._handles.last().expect("pinned directory"),OsStr::new(&staged_name),false,true,true){Ok(stage)=>stage,Err(error)=>{settled();return Err(error)}};
            let result=(||->Result<Value>{
                stage.write_all(&data).context("stage bytes")?;stage.sync_all().context("flush stage")?;
                if let Some(old)=&target{
                    // Keep the exclusive old-file pin. Windows cannot replace
                    // it in one rename without relaxing deletion sharing. Move
                    // that exact handle aside, then publish without overwrite.
                    rename(old,&dir,&backup).context("retain confirmed target")?;between();
                    if let Err(error)=rename(&stage,&dir,&name){
                        if rename(old,&dir,&name).is_err(){
                            return Ok(json!({"changed":false,"recovery_name":backup,"error":"Replacement conflicted. Original bytes remain in the recovery file; no existing destination was overwritten."}));
                        }return Err(error);
                    }
                    if delete_handle(old).is_err(){return Ok(json!({"changed":true,"operation":"replace","bytes":detail["bytes"],"sha256":detail["sha256"],"recovery_name":backup,"warning":"Saved, but the original recovery copy could not be removed."}));}
                }else{between();rename(&stage,&dir,&name)?;}
                Ok(json!({"changed":true,"operation":detail["operation"],"bytes":detail["bytes"],"sha256":detail["sha256"]}))
            })();
            let outcome=match result{Ok(value)=>{if value["changed"]!=true{let _=delete_handle(&stage);}Ok(value)},Err(error)=>{let _=delete_handle(&stage);Err(error)}};
            settled();return outcome;
        }else{delete_handle(target.as_ref().expect("checked deletion target"))?;}
        Ok(json!({"changed":true,"operation":detail["operation"],"bytes":detail["bytes"],"sha256":detail["sha256"]}))
    }
    #[cfg(not(windows))] {let _=change;crate::refuse!(Forbidden,"confirmed file changes require Windows in this release");}
}
/// Engine start: settles each replacement a stop interrupted (4.5.0 review
/// C12). The original goes back under its name unless another file took the
/// name; a replacement already published drops the original, as the change
/// would have; staged bytes never published are removed. A record whose
/// folder cannot be opened now (say, a drive not connected) waits for a later
/// start. Answers how many records were settled and how many wait.
#[nolog]
pub(in crate::domain::apps) fn recover(journal:&Path)->(usize,usize){
    let Ok(records)=std::fs::read_dir(journal) else{return (0,0)};let (mut settled,mut waiting)=(0,0);
    for path in records.flatten().map(|e|e.path()).filter(|p|p.extension().is_some_and(|e|e=="json")){
        let done=match std::fs::read(&path){
            Err(_)=>false,
            // flushed before anything was staged or moved: a cut record moved nothing
            Ok(bytes)=>serde_json::from_slice::<Pending>(&bytes).map_or(true,|pending|settle(&pending).is_ok()),
        };
        if done&&std::fs::remove_file(&path).is_ok(){settled+=1;}else{waiting+=1;}
    }(settled,waiting)
}
#[cfg(windows)]
#[nolog]
fn settle(pending:&Pending)->Result<()>{
    let dir=writable_parent(&pending.directory)?;let pin=dir._handles.last().expect("pinned directory");
    // Only the change's own plain files, opened for deletion relative to the pin.
    let own=|name:&str|->Result<Option<File>>{match anchored_access(pin,OsStr::new(name),false,false,true){
        Ok(file)=>{let meta=file.metadata()?;plain(&meta)?;Ok(meta.is_file().then_some(file))},
        Err(error) if missing(&error)=>Ok(None),
        Err(error)=>Err(error),
    }};
    // Staged bytes are published only by a rename, so a staged name left behind was never published.
    if let Some(stage)=own(&pending.stage)?{delete_handle(&stage)?;}
    let Some(backup)=own(&pending.backup)? else{return Ok(())};
    match anchored_access(pin,OsStr::new(&pending.name),false,false,false){
        // the stop left the original aside: put it back, never over a file that took the name
        Err(error) if missing(&error)=>rename(&backup,&dir,&pending.name),
        Ok(target)=>{
            let mut bytes=Vec::new();(&target).take(WRITE_MAX as u64+1).read_to_end(&mut bytes)?;
            if hex::encode(Sha256::digest(&bytes))==pending.sha256{delete_handle(&backup)?;}Ok(())
        },
        // another file holds the name: the original stays beside it
        Err(_)=>Ok(()),
    }
}
/// Outside Windows commit refuses every change, so no record exists.
#[cfg(not(windows))]
#[nolog]
fn settle(_pending:&Pending)->Result<()>{Ok(())}

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
    // The next start settles each record by what it finds: a published replacement drops the
    // original as the change would have; a name another file took keeps the original aside and
    // removes the staged bytes; a folder that cannot be opened now waits for a later start.
    #[test]fn app_files_the_next_start_settles_each_interrupted_replacement_by_what_it_finds(){
        #[cfg(windows)]{
            let dir=std::env::temp_dir().join(crate::util::uid("apps-settle"));std::fs::create_dir(&dir).unwrap();
            let journal=std::env::temp_dir().join(crate::util::uid("apps-journal"));
            let sha=|bytes:&[u8]|hex::encode(Sha256::digest(bytes));
            let pending=|name:&str|Pending{directory:dir.clone(),name:name.into(),stage:format!(".orgtree-app-save-{name}"),backup:format!(".orgtree-app-recovery-{name}"),sha256:sha(b"new")};
            std::fs::write(dir.join("published.txt"),b"new").unwrap();std::fs::write(dir.join(".orgtree-app-recovery-published.txt"),b"old").unwrap();
            record(&journal,&pending("published.txt")).unwrap();
            std::fs::write(dir.join("taken.txt"),b"another file").unwrap();std::fs::write(dir.join(".orgtree-app-recovery-taken.txt"),b"old").unwrap();
            std::fs::write(dir.join(".orgtree-app-save-taken.txt"),b"new").unwrap();record(&journal,&pending("taken.txt")).unwrap();
            let mut away=pending("away.txt");away.directory=dir.join("not-connected");record(&journal,&away).unwrap();
            assert_eq!(recover(&journal),(2,1));
            assert_eq!(std::fs::read(dir.join("published.txt")).unwrap(),b"new");assert!(!dir.join(".orgtree-app-recovery-published.txt").exists());
            assert_eq!(std::fs::read(dir.join("taken.txt")).unwrap(),b"another file");assert_eq!(std::fs::read(dir.join(".orgtree-app-recovery-taken.txt")).unwrap(),b"old");
            assert!(!dir.join(".orgtree-app-save-taken.txt").exists());
            assert_eq!(std::fs::read_dir(&journal).unwrap().count(),1,"only the unreachable record waits");
            std::fs::remove_dir_all(&dir).unwrap();std::fs::remove_dir_all(&journal).unwrap();
        }
    }
}
