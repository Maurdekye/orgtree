//! WS5 mail: the receiver half of two-stage mail (S3 E1.3-E1.5), the notice
//! box and its fold under the head row (P8), the volatile hint queue, and
//! the mailbox lifecycle helpers the island families call.
//!
//! The source half is [`crate::sent`].

pub mod hints;
pub mod mailbox;
pub mod receive;
pub mod doors;
pub mod human;
pub mod inbox;
pub mod recovery;
pub mod declared;
