use agent_client_protocol::schema::v1::Meta;
use serde_json::{Map, Value};

pub(crate) const ACP_META_LEGACY_KEY: &str = "goose";
pub(crate) const ACP_META_KEY: &str = "openduck";

pub(crate) fn insert_brand_meta(meta: &mut Map<String, Value>, value: Value) {
    meta.insert(ACP_META_LEGACY_KEY.to_string(), value.clone());
    meta.insert(ACP_META_KEY.to_string(), value);
}

pub(crate) fn get_brand_meta(meta: &Map<String, Value>) -> Option<&Value> {
    meta.get(ACP_META_KEY)
        .or_else(|| meta.get(ACP_META_LEGACY_KEY))
}

pub(crate) fn with_brand_meta_object<F>(meta: &mut Meta, f: F)
where
    F: FnOnce(&mut Map<String, Value>),
{
    let mut obj = match get_brand_meta(meta) {
        Some(Value::Object(existing)) => existing.clone(),
        _ => Map::new(),
    };
    f(&mut obj);
    insert_brand_meta(meta, Value::Object(obj));
}
