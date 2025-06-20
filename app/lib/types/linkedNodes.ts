import { Pagination } from "./pagination";


export interface Link {
  block_number: number
  source_node_id: string
  linked_node_id: string
  processed_timestamp: string
}

export interface LinkedNodesResponse {
  links: Link[]
  pagination: Pagination
}