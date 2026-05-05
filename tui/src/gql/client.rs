use crate::error::{AppError, Result};
use graphql_client::{GraphQLQuery, Response};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};

pub struct HttpClient {
    url: String,
    inner: reqwest::Client,
}

impl HttpClient {
    pub fn new(url: String, api_key: Option<String>) -> Result<Self> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if let Some(k) = api_key {
            let v = HeaderValue::from_str(&format!("Bearer {k}"))
                .map_err(|e| AppError::Config(format!("invalid api key: {e}")))?;
            headers.insert(AUTHORIZATION, v);
        }
        let inner = reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .map_err(|e| AppError::Config(format!("reqwest builder: {e}")))?;
        Ok(Self { url, inner })
    }

    pub async fn query<Q: GraphQLQuery>(
        &self,
        variables: Q::Variables,
    ) -> Result<Q::ResponseData>
    where
        Q::Variables: serde::Serialize,
    {
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
            return Err(AppError::GraphQl(format!("{errs:?}")));
        }
        parsed
            .data
            .ok_or_else(|| AppError::GraphQl("no data in response".into()))
    }
}
