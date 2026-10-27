use super::*;
use crate::profile_pictures::{image::{normalize,Crop},wire::{self,next_revision}};

#[nolog]
fn record() -> PictureRecord {
    let mut raw=std::io::Cursor::new(Vec::new());
    ::image::DynamicImage::new_rgba8(3,3).write_to(&mut raw,::image::ImageFormat::Png).unwrap();
    let (png,size)=normalize(&raw.into_inner(),Crop::default()).unwrap();
    wire::from_png(next_revision(None).unwrap(),png,size).unwrap()
}

#[nolog]
fn row(slug:&str,picture:Option<&PictureMeta>,owner:Option<&str>) -> Value {
    let mut r=json!({"slug":slug,"kind":"person","org_name":"","username":slug});
    if let Some(m)=picture {r["picture"]=serde_json::to_value(m).unwrap();}
    if let Some(o)=owner {r["picture_owner"]=json!(o);}
    r
}

#[test]
#[nolog]
fn mention_targets_are_org_or_net_addresses_only() {
    assert_eq!(target("@net:Alice.77DED7"),Some(Target::Net("alice.77ded7".into())));
    assert_eq!(target(" @org:acme-labs "),Some(Target::Org("acme-labs".into())));
    for bad in ["@net:","@org:","@user","net:alice.1","@net:a b","@net:a/b","@agent:x",&format!("@net:{}","a".repeat(201))] {
        assert_eq!(target(bad),None,"{bad}");
    }
}

#[test]
#[nolog]
fn a_roster_advertises_only_valid_owned_metadata() {
    let pic=record();
    let removed=PictureRecord::removed(next_revision(Some(&pic.meta)).unwrap());
    let rows=vec![
        row("set.1",Some(&pic.meta),Some("o1")),
        row("gone.2",Some(&removed.meta),Some("o2")),
        row("never.3",None,Some("o3")),
        row("unowned.4",Some(&pic.meta),None),
        row("bad.5",Some(&PictureMeta{revision:"1-a".into(),..pic.meta.clone()}),Some("o5")),
    ];
    assert_eq!(advertised(&rows,"set.1"),Some((pic.meta.clone(),"o1".into())));
    let (meta,_)=advertised(&rows,"gone.2").unwrap();
    assert!(meta.sha256.is_none(),"a removal is advertised without a hash");
    for missing in ["never.3","unowned.4","bad.5","absent.6"] {assert_eq!(advertised(&rows,missing),None,"{missing}");}
}

#[test]
#[nolog]
fn a_hub_answer_must_match_the_owner_revision_and_bytes() {
    let pic=record();
    let rev=pic.meta.revision.clone();
    let answer=json!({"picture":pic,"picture_owner":"o1"});
    let got=accept(&answer,"o1",&rev).unwrap().expect("the advertised picture");
    assert_eq!(got,pic);
    assert!(accept(&answer,"o2",&rev).is_err(),"another identity's picture");
    let newer=next_revision(Some(&pic.meta)).unwrap();
    assert!(accept(&answer,"o1",&newer).is_err(),"older than the roster advertises");
    assert_eq!(accept(&json!({"picture":null,"picture_owner":"o1"}),"o1",&rev).unwrap(),None);
    let removed=PictureRecord::removed(newer.clone());
    assert_eq!(accept(&json!({"picture":removed,"picture_owner":"o1"}),"o1",&newer).unwrap(),None);
    let mut tampered=pic.clone();
    tampered.meta.sha256=Some("0".repeat(64));
    assert!(accept(&json!({"picture":tampered,"picture_owner":"o1"}),"o1",&rev).is_err(),"hash mismatch");
}
