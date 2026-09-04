//! Drive storage plans (`/api/drive/...`).
//!
//! The per-account storage subscriptions: a plan grants storage and is paid
//! in credits, or by card through Stripe Checkout which mints the credits
//! first. This is a separate rail from the Stripe credit top-ups in
//! `subscriptions.rs`, and from the plan `storage_overview.rs` derives for
//! the top-bar chip, which reads the top-up subscription. Nothing here
//! touches that chip.
//!
//! Every command forwards the API's JSON as-is. The shapes are owned by the
//! frontend's `drive-plans.ts`, the same file the console uses, so the two
//! clients cannot drift on what a plan or a subscription looks like.

use crate::api::client::{ApiClient, ApiError};
use crate::app_state::{AppState, SessionAccount};
use crate::error::AppError;
use serde_json::{Value, json};

const PLANS: &str = "/api/drive/plans/";
const SUBSCRIPTION: &str = "/api/drive/subscription/";
const HISTORY: &str = "/api/drive/subscription/history/";

fn client(state: &tauri::State<'_, AppState>) -> Result<ApiClient, AppError> {
    Ok(ApiClient::new(state.api_client.clone(), state.pool()?.clone()))
}

/// The plan catalogue. Public, and it changes about as often as pricing does.
#[tauri::command]
pub async fn get_drive_plans(state: tauri::State<'_, AppState>, account_id: SessionAccount) -> Result<Value, AppError> {
    Ok(client(&state)?.get::<Value>(PLANS, &account_id).await?)
}

/// The account's drive subscription, or `{ "active": false }` when there is
/// none. Not having one is a normal state, so the API does not 404 it.
#[tauri::command]
pub async fn get_drive_subscription(state: tauri::State<'_, AppState>, account_id: SessionAccount) -> Result<Value, AppError> {
    Ok(client(&state)?.get::<Value>(SUBSCRIPTION, &account_id).await?)
}

/// Subscribe from no plan, paid from the credit balance. 402 when credits
/// are short, 409 when a plan already exists.
#[tauri::command]
pub async fn subscribe_drive_plan(
    state: tauri::State<'_, AppState>,
    account_id: SessionAccount,
    plan: String,
    period: Option<String>,
) -> Result<Value, AppError> {
    let body = json!({ "plan": plan, "period": period.unwrap_or_else(|| "monthly".into()) });
    Ok(client(&state)?.post::<Value, _>(SUBSCRIPTION, &body, &account_id).await?)
}

/// Upgrade or downgrade an existing plan. Refused if usage exceeds the target.
#[tauri::command]
pub async fn change_drive_plan(
    state: tauri::State<'_, AppState>,
    account_id: SessionAccount,
    plan: String,
    period: Option<String>,
) -> Result<Value, AppError> {
    let body = json!({ "plan": plan, "period": period.unwrap_or_else(|| "monthly".into()) });
    Ok(client(&state)?.patch::<Value, _>(SUBSCRIPTION, &body, &account_id).await?)
}

/// Cancel, returning the account to the free plan. Store-billed plans are
/// refused with a 409 and have to be cancelled where they were bought.
#[tauri::command]
pub async fn cancel_drive_subscription(state: tauri::State<'_, AppState>, account_id: SessionAccount) -> Result<(), AppError> {
    client(&state)?.delete(SUBSCRIPTION, &account_id).await?;
    Ok(())
}

/// Pay a plan by card. The API answers with a Stripe Checkout URL; the plan
/// is bought with the credits once they are minted, and the card is kept to
/// fund renewals. Nothing is subscribed until then.
///
/// `return_to` is where Stripe sends the browser afterwards. The desktop
/// cannot receive that redirect, so callers point it at the console's plans
/// page and poll the intent from here instead.
#[tauri::command]
pub async fn start_drive_card_checkout(
    state: tauri::State<'_, AppState>,
    account_id: SessionAccount,
    plan: String,
    period: Option<String>,
    return_to: Option<String>,
) -> Result<Value, AppError> {
    let body = json!({
        "plan": plan,
        "period": period.unwrap_or_else(|| "monthly".into()),
        "payment": "card",
        "return_to": return_to,
    });
    Ok(client(&state)?.post::<Value, _>(SUBSCRIPTION, &body, &account_id).await?)
}

/// Progress of a card checkout: pending, paid (minting), fulfilled or failed.
#[tauri::command]
pub async fn get_drive_checkout_intent(state: tauri::State<'_, AppState>, account_id: SessionAccount, intent_id: String) -> Result<Value, AppError> {
    let path = format!("{SUBSCRIPTION}checkout/{intent_id}/");
    Ok(client(&state)?.get::<Value>(&path, &account_id).await?)
}

/// Every charge and change on the drive plan, newest first.
///
/// A 404 is not an error here: it is what the API returns until the endpoint
/// ships, and what a brand-new account with no ledger may return after. Both
/// read as "nothing yet", which is true either way.
#[tauri::command]
pub async fn get_drive_subscription_history(state: tauri::State<'_, AppState>, account_id: SessionAccount) -> Result<Value, AppError> {
    match client(&state)?.get::<Value>(HISTORY, &account_id).await {
        Ok(v) => Ok(v),
        Err(ApiError::Http { status: 404, .. }) => Ok(json!({ "results": [] })),
        Err(e) => Err(e.into()),
    }
}
