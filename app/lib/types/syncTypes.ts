export interface StagedFile {
  file_id: string;
  path: string;
}

export interface StagedConflict {
  file_id: string;
  path: string;
  conflict_type: "modify_modify" | "modify_delete" | "delete_modify" | "create_create";
  has_local: boolean;
  has_remote: boolean;
}

export interface StagedChanges {
  uploads: StagedFile[];
  downloads: StagedFile[];
  local_deletes: StagedFile[];
  remote_deletes: StagedFile[];
  conflicts: StagedConflict[];
  unchanged_count: number;
}

export type ConflictResolution = "keep_local" | "accept_remote" | "keep_both" | "skip";
