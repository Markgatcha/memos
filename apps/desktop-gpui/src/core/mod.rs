#[cfg(feature = "gui")]
#[macro_export]
macro_rules! core_info {
    ($($t:tt)*) => {
        tracing::info!($($t)*)
    };
}

#[cfg(not(feature = "gui"))]
#[macro_export]
macro_rules! core_info {
    ($($t:tt)*) => {};
}

#[cfg(feature = "gui")]
#[macro_export]
macro_rules! core_debug {
    ($($t:tt)*) => {
        tracing::debug!($($t)*)
    };
}

#[cfg(not(feature = "gui"))]
#[macro_export]
macro_rules! core_debug {
    ($($t:tt)*) => {};
}

#[cfg(feature = "gui")]
#[macro_export]
macro_rules! core_warn {
    ($($t:tt)*) => {
        tracing::warn!($($t)*)
    };
}

#[cfg(not(feature = "gui"))]
#[macro_export]
macro_rules! core_warn {
    ($($t:tt)*) => {};
}

pub mod db;
pub mod easter_eggs;
pub mod harness;
pub mod health;
pub mod model;
pub mod settings;
pub mod write_bridge;
