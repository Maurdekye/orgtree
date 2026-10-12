//! Native bounded decoding; the renderer receives only a small stripped preview.
use std::io::Cursor;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use super::{Error, Result, wire::{MAX_INPUT_BYTES,MAX_PIXELS,MAX_BYTES}};

#[derive(Clone, Copy, Deserialize)]
pub struct Crop { pub x: f64, pub y: f64, pub size: f64 }
impl Default for Crop { #[nolog] fn default()->Self { Self{x:0.5,y:0.5,size:1.0} } }
#[derive(Serialize)]
pub struct Preview { pub data: String, pub width: u32, pub height: u32 }
#[nolog]
fn invalid()->Error { Error::Invalid("Choose a static PNG, JPEG or WebP up to 5 MiB and 16 megapixels".into()) }

#[nolog]

pub fn decode_input(data: &str) -> Result<Vec<u8>> {
    if data.len()>(MAX_INPUT_BYTES+2)/3*4 { return Err(invalid()); }
    let bytes=B64.decode(data).map_err(|_|invalid())?;
    if bytes.len()>MAX_INPUT_BYTES { return Err(invalid()); }
    Ok(bytes)
}

#[nolog]

fn decoded(bytes:&[u8])->Result<DynamicImage> {
    if bytes.len()>MAX_INPUT_BYTES { return Err(invalid()); }
    let format=image::guess_format(bytes).map_err(|_|invalid())?;
    if !matches!(format,ImageFormat::Png|ImageFormat::Jpeg|ImageFormat::WebP) { return Err(invalid()); }
    // Parse chunk boundaries instead of rejecting arbitrary pixel byte patterns.
    if format==ImageFormat::Png {
        let mut at=8usize;
        while at+12<=bytes.len() {
            let len=u32::from_be_bytes(bytes[at..at+4].try_into().unwrap()) as usize;
            if &bytes[at+4..at+8]==b"acTL" { return Err(invalid()); }
            at=at.checked_add(12).and_then(|n|n.checked_add(len)).filter(|n|*n<=bytes.len()).ok_or_else(invalid)?;
        }
    } else if format==ImageFormat::WebP {
        let mut at=12usize;
        while at+8<=bytes.len() {
            let len=u32::from_le_bytes(bytes[at+4..at+8].try_into().unwrap()) as usize;
            let kind=&bytes[at..at+4];
            if matches!(kind,b"ANIM"|b"ANMF") || (kind==b"VP8X" && bytes.get(at+8).is_some_and(|b|b&2!=0)) { return Err(invalid()); }
            at=at.checked_add(8).and_then(|n|n.checked_add(len)).and_then(|n|n.checked_add(len%2)).filter(|n|*n<=bytes.len()).ok_or_else(invalid)?;
        }
    }
    let mut reader=ImageReader::with_format(Cursor::new(bytes),format);
    let mut limits=image::Limits::default();
    limits.max_image_width=Some(16_000_000);
    limits.max_image_height=Some(16_000_000);
    limits.max_alloc=Some(128*1024*1024);
    reader.limits(limits);
    let mut decoder=reader.into_decoder().map_err(|_|invalid())?;
    let (w,h)=decoder.dimensions();
    if w==0 || h==0 || u64::from(w)*u64::from(h)>MAX_PIXELS { return Err(invalid()); }
    let orientation=decoder.orientation().map_err(|_|invalid())?;
    let mut image=DynamicImage::from_decoder(decoder).map_err(|_|invalid())?;
    image.apply_orientation(orientation);
    Ok(image)
}

#[nolog]

fn bounded_png(mut image:DynamicImage)->Result<(Vec<u8>,u32,u32)> {
    if image.width()>512 || image.height()>512 { image=image.resize(512,512,image::imageops::FilterType::Lanczos3); }
    loop {
        let pixels=image.to_rgba8();
        let (w,h)=pixels.dimensions();
        let mut out=Vec::new();
        { let mut enc=png::Encoder::new(&mut out,w,h); enc.set_depth(png::BitDepth::Eight);enc.set_color(png::ColorType::Rgba);
          enc.write_header().map_err(|_|invalid())?.write_image_data(&pixels).map_err(|_|invalid())?; }
        if out.len()<=MAX_BYTES { return Ok((out,w,h)); }
        image=image.resize((w*3/4).max(1),(h*3/4).max(1),image::imageops::FilterType::Lanczos3);
    }
}
#[nolog]
pub fn preview(bytes:&[u8])->Result<Preview> {
    let (png,width,height)=bounded_png(decoded(bytes)?)?;
    Ok(Preview{data:B64.encode(png),width,height})
}
#[nolog]
pub fn normalize(bytes:&[u8], crop:Crop)->Result<(Vec<u8>,u32)> {
    if !crop.x.is_finite() || !crop.y.is_finite() || !crop.size.is_finite()
        || !(0.0..=1.0).contains(&crop.x) || !(0.0..=1.0).contains(&crop.y) || !(0.1..=1.0).contains(&crop.size) {
        return Err(Error::Invalid("Invalid square crop".into()));
    }
    let image=decoded(bytes)?;
    let side=((image.width().min(image.height()) as f64*crop.size).round() as u32).max(1);
    let x=((image.width()-side) as f64*crop.x).round() as u32;
    let y=((image.height()-side) as f64*crop.y).round() as u32;
    let (png,w,_)=bounded_png(image.crop_imm(x,y,side,side))?;
    Ok((png,w))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[nolog]
    fn png(w:u32,h:u32)->Vec<u8> { let image=DynamicImage::new_rgba8(w,h);let mut out=Cursor::new(Vec::new());image.write_to(&mut out,ImageFormat::Png).unwrap();out.into_inner() }
    #[test]
    #[nolog]
    fn static_formats_crop_to_stripped_bounded_square() {
        for format in [ImageFormat::Png,ImageFormat::Jpeg,ImageFormat::WebP] {
            let image=DynamicImage::new_rgb8(1000,700);let mut raw=Cursor::new(Vec::new());image.write_to(&mut raw,format).unwrap();
            let (bytes,size)=normalize(&raw.into_inner(),Crop{x:1.0,y:0.0,size:0.5}).unwrap();
            assert_eq!(size,350);super::super::wire::validate_png(&bytes,size).unwrap();
        }
    }
    #[test]
    #[nolog]
    fn bad_formats_animation_bombs_and_invalid_crop_are_rejected() {
        assert!(preview(b"<svg></svg>").is_err());assert!(preview(&vec![0;MAX_INPUT_BYTES+1]).is_err());
        let mut animated=png(2,2);animated.splice(8..8,[0,0,0,0,b'a',b'c',b'T',b'L',0,0,0,0]);assert!(preview(&animated).is_err());
        assert!(preview(&png(4001,4000)).is_err());
        assert!(normalize(&png(2,2),Crop{x:f64::NAN,..Crop::default()}).is_err());
        assert!(normalize(&png(2,2),Crop{size:0.0,..Crop::default()}).is_err());
    }
}

