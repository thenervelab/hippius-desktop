import { Pagination } from "./pagination";

export interface EventData {
  [key: string]: unknown;
}

export interface Event {
  block_number: number;
  event_index: number;
  pallet_name: string;
  event_name: string;
  phase_type: string;
  phase_value: string;
  event_data: EventData;
  documentation: string;
  processed_timestamp: string;
}

export interface EventsResponse {
  events: Event[];
  pagination: Pagination;
}
