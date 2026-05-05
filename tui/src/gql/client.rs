use crate::error::{AppError, Result};
use graphql_client::{GraphQLQuery, Response};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use std::time::Duration;

pub struct HttpClient {
    url: String,
    inner: reqwest::Client,
}

impl HttpClient {
    pub fn new(url: String, api_key: Option<String>) -> Result<Self> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if let Some(k) = api_key {
            let v = HeaderValue::from_str(&format!("Bearer {k}"))?;
            headers.insert(AUTHORIZATION, v);
        }
        let inner = reqwest::Client::builder()
            .default_headers(headers)
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| AppError::Config(format!("reqwest builder: {e}")))?;
        Ok(Self { url, inner })
    }

    pub async fn query<Q: GraphQLQuery>(&self, variables: Q::Variables) -> Result<Q::ResponseData> {
        let body = Q::build_query(variables);
        let resp = self
            .inner
            .post(&self.url)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::ApiUnreachable {
                url: self.url.clone(),
                source: e,
            })?;
        let parsed: Response<Q::ResponseData> = resp
            .json()
            .await
            .map_err(|e| AppError::GraphQl(format!("decode: {e}")))?;
        if let Some(errs) = parsed.errors {
            let first = errs
                .first()
                .map(|e| e.message.as_str())
                .unwrap_or("(empty)");
            let extra = if errs.len() > 1 {
                format!(" (+{} more)", errs.len() - 1)
            } else {
                String::new()
            };
            return Err(AppError::GraphQl(format!("{first}{extra}")));
        }
        parsed
            .data
            .ok_or_else(|| AppError::GraphQl("no data in response".into()))
    }
}
