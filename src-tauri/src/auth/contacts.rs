//! Address book (contacts) CRUD.

use crate::app_state::AppState;
use crate::error::AppError;
use tracing::info;

#[derive(serde::Serialize)]
pub struct Contact {
    pub id: i64,
    pub name: String,
    pub wallet_address: String,
    pub date_added: i64,
}

/// Add a contact to the address book.
#[tauri::command]
pub async fn add_contact(state: tauri::State<'_, AppState>, name: String, wallet_address: String) -> Result<i64, AppError> {
    let pool = state.pool()?;

    info!(name = %name, "Adding contact");
    let result = sqlx::query("INSERT INTO address_book (name, wallet_address) VALUES (?, ?)")
        .bind(&name)
        .bind(&wallet_address)
        .execute(pool)
        .await?;

    Ok(result.last_insert_rowid())
}

/// Get all contacts, ordered by name ascending.
#[tauri::command]
pub async fn get_contacts(state: tauri::State<'_, AppState>) -> Result<Vec<Contact>, AppError> {
    let pool = state.pool()?;

    let rows = sqlx::query_as::<_, (i64, String, String, i64)>("SELECT id, name, wallet_address, date_added FROM address_book ORDER BY name ASC")
        .fetch_all(pool)
        .await?;

    Ok(rows
        .into_iter()
        .map(|(id, name, wallet_address, date_added)| Contact {
            id,
            name,
            wallet_address,
            date_added,
        })
        .collect())
}

/// Update a contact's name and wallet address.
#[tauri::command]
pub async fn update_contact(state: tauri::State<'_, AppState>, id: i64, name: String, wallet_address: String) -> Result<(), AppError> {
    let pool = state.pool()?;

    sqlx::query("UPDATE address_book SET name = ?, wallet_address = ? WHERE id = ?")
        .bind(&name)
        .bind(&wallet_address)
        .bind(id)
        .execute(pool)
        .await?;

    Ok(())
}

/// Delete a contact from the address book.
#[tauri::command]
pub async fn delete_contact(state: tauri::State<'_, AppState>, id: i64) -> Result<(), AppError> {
    info!(id = id, "Deleting contact");
    let pool = state.pool()?;

    sqlx::query("DELETE FROM address_book WHERE id = ?").bind(id).execute(pool).await?;

    Ok(())
}

// ── Onboarding ──────────────────────────────────────────────────────────
