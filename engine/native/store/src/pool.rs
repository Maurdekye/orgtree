//! A bounded fair pool (C1). Admission is a FIFO semaphore (tokio's
//! `Semaphore` grants permits in request order), so a burst cannot starve an
//! earlier waiter. Broken sessions are discarded, never reused.

use std::ops::{Deref, DerefMut};
use std::sync::Mutex;

use tokio::sync::{Semaphore, SemaphorePermit};

use crate::session::{Connector, DbError, Session};

pub struct Pool<C: Connector> {
    connector: C,
    sem: Semaphore,
    idle: Mutex<Vec<C::S>>,
    size: usize,
}

impl<C: Connector> Pool<C> {
    pub fn new(connector: C, size: usize) -> Self {
        assert!(size > 0, "pool size must be positive");
        Pool { connector, sem: Semaphore::new(size), idle: Mutex::new(Vec::new()), size }
    }

    pub fn size(&self) -> usize {
        self.size
    }

    /// Permits currently free (for tests and admission reporting).
    pub fn available(&self) -> usize {
        self.sem.available_permits()
    }

    pub fn connector(&self) -> &C {
        &self.connector
    }

    pub async fn get(&self) -> Result<Pooled<'_, C>, DbError> {
        let permit = self.sem.acquire().await.map_err(|_| DbError::lost())?;
        let reuse = self.idle.lock().unwrap().pop();
        let sess = match reuse {
            Some(s) => s,
            None => self.connector.connect().await?,
        };
        Ok(Pooled { pool: self, sess: Some(sess), _permit: permit })
    }
}

pub struct Pooled<'a, C: Connector> {
    pool: &'a Pool<C>,
    sess: Option<C::S>,
    _permit: SemaphorePermit<'a>,
}

impl<C: Connector> Deref for Pooled<'_, C> {
    type Target = C::S;
    fn deref(&self) -> &C::S {
        self.sess.as_ref().unwrap()
    }
}

impl<C: Connector> DerefMut for Pooled<'_, C> {
    fn deref_mut(&mut self) -> &mut C::S {
        self.sess.as_mut().unwrap()
    }
}

impl<C: Connector> Drop for Pooled<'_, C> {
    fn drop(&mut self) {
        if let Some(s) = self.sess.take() {
            if !s.is_broken() {
                self.pool.idle.lock().unwrap().push(s);
            }
        }
    }
}
