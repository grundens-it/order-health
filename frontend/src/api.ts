// Typed fetch helpers for the backend read API. The shared package supplies the
// response types, so the frontend and backend agree on the as_of envelope.
import type {
  ChannelFilter,
  OrdersResponse,
  PipelinesResponse,
} from '@order-health/shared';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url} responded ${res.status}`);
  }
  return (await res.json()) as T;
}

export function fetchPipelines(): Promise<PipelinesResponse> {
  return getJson<PipelinesResponse>('/api/health/pipelines');
}

export function fetchOrders(channel: ChannelFilter): Promise<OrdersResponse> {
  return getJson<OrdersResponse>(`/api/health/orders?channel=${channel}`);
}
