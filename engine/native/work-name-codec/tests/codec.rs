use orgtree_work_name_codec::*;

const UUID: [u8; 16] = [
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x46, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
];
const TOKEN: &str = "aaisem2ekvdhpcezvk54zxpo74";

fn limits() -> PreflightLimits {
    PreflightLimits {
        max_entries: 32,
        max_name_bytes: 1024,
        max_total_bytes: 8192,
    }
}

#[test]
fn rfc4648_network_order_and_full_length_names() {
    assert_eq!(encode_token(&UUID).unwrap(), TOKEN);
    assert_eq!(decode_token(TOKEN).unwrap(), UUID);
    let prefix = "a".repeat(48);
    let name = encode_name(&prefix, &UUID).unwrap();
    assert_eq!(name.len(), 76);
    assert_eq!(
        decode_name(&name).unwrap(),
        DecodedName {
            prefix: &prefix,
            uuid: UUID
        }
    );
    assert_eq!(
        encode_name("item", &UUID).unwrap(),
        format!("item--{TOKEN}")
    );
}

#[test]
fn preserves_each_of_the_122_variable_identity_bits() {
    let mut tokens = std::collections::HashSet::new();
    tokens.insert(encode_token(&UUID).unwrap());
    for byte in 0..16 {
        for bit in 0..8 {
            if (byte == 6 && bit >= 4) || (byte == 8 && bit >= 6) {
                continue;
            }
            let mut changed = UUID;
            changed[byte] ^= 1 << bit;
            let token = encode_token(&changed).unwrap();
            assert!(tokens.insert(token.clone()), "lost byte {byte} bit {bit}");
            assert_eq!(decode_token(&token).unwrap(), changed);
        }
    }
    assert_eq!(tokens.len(), 123);
}

#[test]
fn suffix_and_complete_key_are_never_shortened_or_normalized() {
    let first = encode_name("same-prefix", &UUID).unwrap();
    let mut other = UUID;
    other[15] ^= 1;
    let second = encode_name("same-prefix", &other).unwrap();
    assert_ne!(first, second);
    let retitled = encode_name("different-prefix", &UUID).unwrap();
    assert_ne!(first, retitled);
    assert_eq!(
        decode_name(&first).unwrap().uuid,
        decode_name(&retitled).unwrap().uuid
    );
    assert!(decode_name(TOKEN).is_err());
    assert!(decode_name(&first.to_uppercase()).is_err());
    assert!(decode_name(&format!(" {first}")).is_err());
    assert!(decode_name(&format!("{first}\n")).is_err());
}

#[test]
fn rejects_all_nonzero_padding_aliases() {
    // The last canonical digit '4' is 28: low two bits must be zero.
    for last in ['5', '6', '7'] {
        let token = format!("{}{last}", &TOKEN[..25]);
        assert_eq!(decode_token(&token), Err(NameError::NonZeroPadding));
        assert_eq!(
            decode_name(&format!("item--{token}")),
            Err(NameError::NonZeroPadding)
        );
    }
}

#[test]
fn rejects_case_crockford_and_padding_characters() {
    assert_eq!(
        decode_token(&TOKEN.to_uppercase()),
        Err(NameError::InvalidAlphabet)
    );
    for byte in ['0', '1', '8', '9', '=', '-', ' ', '\0'] {
        let token = format!("{byte}{}", &TOKEN[1..]);
        assert_eq!(decode_token(&token), Err(NameError::InvalidAlphabet));
    }
    assert_eq!(
        decode_token(&TOKEN[..25]),
        Err(NameError::InvalidTokenLength)
    );
    assert_eq!(
        decode_token(&format!("{TOKEN}======")),
        Err(NameError::InvalidTokenLength)
    );
    assert_eq!(
        decode_token(&format!("é{}", &TOKEN[2..])),
        Err(NameError::InvalidAlphabet)
    );
}

#[test]
fn rejects_every_wrong_version_and_variant_on_encoding() {
    for version in 0..16 {
        let mut value = UUID;
        value[6] = (version << 4) | (UUID[6] & 15);
        if version != 4 {
            assert_eq!(encode_token(&value), Err(NameError::InvalidUuidVersion));
        }
    }
    for variant in 0..4 {
        let mut value = UUID;
        value[8] = (variant << 6) | (UUID[8] & 63);
        if variant != 2 {
            assert_eq!(encode_token(&value), Err(NameError::InvalidUuidVariant));
        }
    }
}

#[test]
fn rejects_non_v4_and_non_rfc_variant_on_decoding() {
    assert_eq!(
        decode_token("aaaaaaaaaaaaaaaaaaaaaaaaaa"),
        Err(NameError::InvalidUuidVersion)
    );
    // RFC 4648 encodings of 00000000-0000-4000-{0000,c000}-000000000000.
    assert_eq!(
        decode_token("aaaaaaaaabaaaaaaaaaaaaaaaa"),
        Err(NameError::InvalidUuidVariant)
    );
    assert_eq!(
        decode_token("aaaaaaaaabaabqaaaaaaaaaaaa"),
        Err(NameError::InvalidUuidVariant)
    );
}

#[test]
fn rejects_malformed_prefixes_without_title_derivation() {
    for prefix in [
        "", "UPPER", "-edge", "edge-", "a--b", "a_b", "a b", "é", "a\0b",
    ] {
        assert_eq!(encode_name(prefix, &UUID), Err(NameError::InvalidPrefix));
        assert!(decode_name(&format!("{prefix}--{TOKEN}")).is_err());
    }
    assert_eq!(
        encode_name(&"a".repeat(49), &UUID),
        Err(NameError::InvalidPrefix)
    );
    assert!(decode_name(&format!("{}--{TOKEN}", "a".repeat(49))).is_err());
    assert!(decode_name(&format!("item---{TOKEN}")).is_err());
    assert!(decode_name(&format!("item{TOKEN}")).is_err());
    for prefix in ["a", "1", "a-b-c", "item", "123"] {
        assert_eq!(
            decode_name(&encode_name(prefix, &UUID).unwrap())
                .unwrap()
                .prefix,
            prefix
        );
    }
}

#[test]
fn mixed_endian_guid_is_never_the_same_identity() {
    assert_eq!(
        decode_token("gmrbcacvir3uncezvk54zxpo74"),
        Err(NameError::InvalidUuidVersion)
    );
    let network = decode_token("aaisem2ekvdepcezvk54zxpo74").unwrap();
    let swapped = decode_token("gmrbcacvirduncezvk54zxpo74").unwrap();
    assert_ne!(network, swapped); // Both are v4; syntax cannot detect the caller's byte-order error.
}

#[test]
fn legacy_preflight_is_broader_than_canonical_decoding() {
    let canonical = format!("item--{TOKEN}");
    let padding = format!("item--{}5", &TOKEN[..25]);
    let zero_uuid = "item--aaaaaaaaaaaaaaaaaaaaaaaaaa";
    let long_prefix = format!("{}--{TOKEN}", "a".repeat(49));
    let imported = [
        "OLD Name ☃\0 ",
        &canonical,
        &padding,
        zero_uuid,
        &long_prefix,
        &padding,
    ];
    let report = preflight_legacy_names(&imported, limits()).unwrap();
    assert!(!report.namespace_is_disjoint());
    assert_eq!(
        report.conflicts.iter().map(|v| v.index).collect::<Vec<_>>(),
        [1, 2, 3, 4, 5]
    );
    for conflict in report.conflicts {
        assert_eq!(conflict.name, imported[conflict.index]);
        assert!(std::ptr::eq(
            conflict.name.as_ptr(),
            imported[conflict.index].as_ptr()
        ));
    }
}

#[test]
fn legacy_noncollisions_are_not_rewritten_or_rejected_as_new_names() {
    let uppercase = format!("item--{}", TOKEN.to_uppercase());
    let malformed_prefix = format!("a--b--{TOKEN}");
    let uppercase_prefix = format!("ITEM--{TOKEN}");
    let imported = [
        "",
        "odd ☃\0 ",
        "a-2",
        "--aaaaaaaaaaaaaaaaaaaaaaaaaa",
        TOKEN,
        &uppercase,
        &malformed_prefix,
        &uppercase_prefix,
    ];
    assert!(preflight_legacy_names(&imported, limits())
        .unwrap()
        .namespace_is_disjoint());
}

#[test]
fn corpus_limits_fail_closed_and_count_utf8_bytes() {
    let zero = PreflightLimits {
        max_entries: 0,
        max_name_bytes: 0,
        max_total_bytes: 0,
    };
    assert!(preflight_legacy_names(&[], zero)
        .unwrap()
        .namespace_is_disjoint());
    assert_eq!(
        preflight_legacy_names(&[""], zero),
        Err(PreflightError::TooManyEntries {
            actual: 1,
            limit: 0
        })
    );
    let exact = PreflightLimits {
        max_entries: 2,
        max_name_bytes: 2,
        max_total_bytes: 4,
    };
    assert!(preflight_legacy_names(&["é", "ab"], exact)
        .unwrap()
        .namespace_is_disjoint());
    assert_eq!(
        preflight_legacy_names(&["☃"], exact),
        Err(PreflightError::NameTooLarge {
            index: 0,
            actual: 3,
            limit: 2
        })
    );
    assert_eq!(
        preflight_legacy_names(
            &["é", "ab"],
            PreflightLimits {
                max_total_bytes: 3,
                ..exact
            }
        ),
        Err(PreflightError::TotalBytesExceeded { index: 1, limit: 3 })
    );
    let conflict = format!("item--{TOKEN}");
    assert!(matches!(
        preflight_legacy_names(&[&conflict, "oversized"], exact),
        Err(PreflightError::NameTooLarge { index: 0, .. })
    ));
    let bounds = PreflightLimits {
        max_entries: 2,
        max_name_bytes: conflict.len(),
        max_total_bytes: conflict.len(),
    };
    assert!(matches!(
        preflight_legacy_names(&[&conflict, "x"], bounds),
        Err(PreflightError::TotalBytesExceeded { index: 1, .. })
    ));
}
