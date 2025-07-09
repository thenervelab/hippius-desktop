export type IpfsUserFileCollectionData = {
    created_at: number;
    file_hash: number[];
    file_name: string;
    is_assigned: boolean;
    last_charged_at: number;
    miner_ids: string[];
    owner: string;
    selected_validator: string;
    total_replicas: number;
    file_size_in_bytes: number;
};

export type IpfsUserFileCollectionDataResponse =
    | IpfsUserFileCollectionData
    | IpfsUserFileCollectionData[];
