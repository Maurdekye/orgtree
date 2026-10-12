//! Identity-wide picture records. Reconnect republishes a revision; only an
//! explicit edit creates one. Logical ordering does not depend on wall clocks.
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use super::{Error, Result};

pub const MAX_BYTES: usize = 256 * 1024;
pub const MAX_INPUT_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_PIXELS: u64 = 16_000_000;
pub const MAX_WIRE_BYTES: usize = MAX_BYTES * 4 / 3 + 4096;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PictureMeta {
    pub revision: String,
    pub sha256: Option<String>,
    pub width: u32,
    pub height: u32,
    pub bytes: u32,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct PictureRecord {
    #[serde(flatten)]
    pub meta: PictureMeta,
    pub data: Option<String>,
}
impl std::fmt::Debug for PictureRecord {
    #[nolog]
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PictureRecord").field("meta",&self.meta).finish_non_exhaustive()
    }
}

#[nolog]

pub fn revision_counter(s: &str) -> Option<u64> {
    if s.len()!=53 || s.as_bytes()[20]!=b'-' || !s.as_bytes()[..20].iter().all(u8::is_ascii_digit)
        || !s.as_bytes()[21..].iter().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c)) { return None; }
    s[..20].parse::<u64>().ok().filter(|n|*n>0)
}
#[nolog]
pub fn next_revision(observed: Option<&PictureMeta>) -> Result<String> {
    let n=observed.map(|m|revision_counter(&m.revision).unwrap_or(0)).unwrap_or(0)
        .checked_add(1).ok_or_else(||Error::Invalid("Picture revision is exhausted".into()))?;
    Ok(format!("{n:020}-{}",uuid::Uuid::new_v4().simple()))
}
impl PictureMeta {
    #[nolog]
    pub fn valid(&self) -> bool {
        if revision_counter(&self.revision).is_none() { return false; }
        match &self.sha256 {
            None => self.bytes==0 && self.width==0 && self.height==0,
            Some(h) => h.len()==64 && h.bytes().all(|c|c.is_ascii_digit()||(b'a'..=b'f').contains(&c))
                && self.bytes>0 && self.bytes as usize<=MAX_BYTES && self.width>0 && self.width<=512 && self.width==self.height,
        }
    }
}
impl PictureRecord {
    #[nolog]
    pub fn removed(revision: String) -> Self {
        Self{meta:PictureMeta{revision,sha256:None,width:0,height:0,bytes:0},data:None}
    }
    /// Verify transport size and hash before decoding or displaying any image.
    #[nolog]
    pub fn decoded(&self) -> Result<Option<Vec<u8>>> {
        let invalid=||Error::Invalid("Invalid profile picture".into());
        if !self.meta.valid() { return Err(invalid()); }
        match (&self.meta.sha256,&self.data) {
            (None,None)=>Ok(None),
            (Some(hash),Some(data)) if data.len()<=(MAX_BYTES+2)/3*4=>{
                let bytes=B64.decode(data).map_err(|_|invalid())?;
                if bytes.len()!=self.meta.bytes as usize || hex::encode(Sha256::digest(&bytes))!=*hash
                    || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") { return Err(invalid()); }
                validate_png(&bytes, self.meta.width)?;
                Ok(Some(bytes))
            },
            _=>Err(invalid()),
        }
    }
}

/// The hub contract permits no ancillary metadata or animation chunks.
#[nolog]
pub fn validate_png(bytes: &[u8], size: u32) -> Result<()> {
    let invalid=||Error::Invalid("Invalid normalized picture".into());
    if bytes.len()>MAX_BYTES || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") { return Err(invalid()); }
    let mut at=8usize;
    let mut ended=false;
    while at+12<=bytes.len() {
        let len=u32::from_be_bytes(bytes[at..at+4].try_into().unwrap()) as usize;
        let end=at.checked_add(12).and_then(|n|n.checked_add(len)).filter(|n|*n<=bytes.len()).ok_or_else(invalid)?;
        let kind=&bytes[at+4..at+8];
        if !matches!(kind,b"IHDR"|b"IDAT"|b"IEND") { return Err(invalid()); }
        at=end;
        if kind==b"IEND" { ended=true; break; }
    }
    if !ended || at!=bytes.len() { return Err(invalid()); }
    let mut decoder=png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_limits(png::Limits{bytes:2*1024*1024});
    let mut reader=decoder.read_info().map_err(|_|invalid())?;
    let i=reader.info();
    if i.width!=size || i.height!=size || size==0 || size>512 || i.bit_depth!=png::BitDepth::Eight
        || !matches!(i.color_type,png::ColorType::Rgb|png::ColorType::Rgba) { return Err(invalid()); }
    reader.next_frame(&mut vec![0;reader.output_buffer_size()]).map_err(|_|invalid())?;
    Ok(())
}

#[nolog]

pub fn from_png(revision: String, bytes: Vec<u8>, size: u32) -> Result<PictureRecord> {
    validate_png(&bytes,size)?;
    Ok(PictureRecord{meta:PictureMeta{revision,sha256:Some(hex::encode(Sha256::digest(&bytes))),width:size,height:size,bytes:bytes.len() as u32},data:Some(B64.encode(bytes))})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[nolog]
    fn revisions_and_tombstones_survive_replay_without_clock_ordering() {
        let a=PictureRecord::removed(next_revision(None).unwrap());
        let b=PictureRecord::removed(next_revision(Some(&a.meta)).unwrap());
        assert!(a.meta.valid()&&b.meta.valid());
        assert!(a.meta.revision<b.meta.revision);
        assert!(b.decoded().unwrap().is_none());
        for rev in ["", "1-a", "00000000000000000000-00000000000000000000000000000001"] { assert!(revision_counter(rev).is_none()); }
        let mut bad=b.clone(); bad.data=Some("old bytes".into()); assert!(bad.decoded().is_err());
    }
}

