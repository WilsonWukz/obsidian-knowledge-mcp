export { ReviewPlans } from "../src/review/store";
export { GuardedSyncLedger } from "../src/sync/durable-object";

export default {
  async fetch(_request: Request): Promise<Response> {
    return new Response("test stub");
  },
};
