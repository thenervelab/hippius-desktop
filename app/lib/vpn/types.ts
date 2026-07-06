// Frontend mirrors of the Rust VPN IPC wire types.
//
// There is no codegen from Rust (see ipcContract.test.ts), so these are kept in
// sync with `src-tauri/src/vpn/engine.rs` (MeshStatus / LocalEndpoint /
// MeshTarget) and `vpn/commands.rs` (VpnStatusInfo) by hand. Shape drift is
// caught by the Rust-side serde and the IPC name contract test.

/** Connection state of the embedded mesh peer — the `kind` tag of `MeshStatus`. */
export type MeshStatusKind =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

/** Serialized `MeshStatus` (tagged): `{ kind, message? }`. */
export interface MeshStatus {
  kind: MeshStatusKind;
  /** Present only for `kind: "error"`. */
  message?: string;
}

/** Response of the `vpn_status` command: `MeshStatus` flattened + `supported`. */
export interface VpnStatusInfo extends MeshStatus {
  /** Whether this build carries a real engine (`netbird-vpn` feature). */
  supported: boolean;
}

/** A localhost endpoint forwarding over the mesh to a VM (`LocalEndpoint`). */
export interface VpnEndpoint {
  host: string;
  port: number;
}

/** A VM service to reach over the overlay (`MeshTarget`). */
export interface VmVpnTarget {
  /** Overlay address of the VM peer (the `nebula_ip` successor). */
  address: string;
  /** Service port on the VM (e.g. 22 for SSH). */
  port: number;
}

/** One active forward from `vpn_list_connections` (`VpnConnectionInfo`). */
export interface VpnConnectionInfo {
  address: string;
  port: number;
  endpoint: VpnEndpoint;
}
