import { invoke } from "@tauri-apps/api/core";

export async function addContact(
  name: string,
  walletAddress: string
): Promise<boolean> {
  try {
    await invoke("add_contact", { name, walletAddress });
    return true;
  } catch (error) {
    console.error("Failed to add contact:", error);
    return false;
  }
}

export async function getContacts(): Promise<
  Array<{ id: number; name: string; walletAddress: string; dateAdded: number }>
> {
  try {
    return await invoke("get_contacts");
  } catch (error) {
    console.error("Failed to get contacts:", error);
    return [];
  }
}

export async function updateContact(
  id: number,
  name: string,
  walletAddress: string
): Promise<boolean> {
  try {
    await invoke("update_contact", { id, name, walletAddress });
    return true;
  } catch (error) {
    console.error("Failed to update contact:", error);
    return false;
  }
}

export async function deleteContact(id: number): Promise<boolean> {
  try {
    await invoke("delete_contact", { id });
    return true;
  } catch (error) {
    console.error("Failed to delete contact:", error);
    return false;
  }
}
