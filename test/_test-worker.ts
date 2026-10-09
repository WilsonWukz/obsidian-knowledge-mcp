export { ReviewPlans } from "../src/review/store";

export default {
  async fetch(_request: Request): Promise<Response> {
    return new Response("test stub");
  },
};
