/**
 * Compile-time conformance: the browser-side mirror types must stay mutually
 * assignable with the frozen server types. If the backend changes a view shape
 * without the web model following, `npm run typecheck` fails here. Type-only;
 * emits no runtime code.
 */
import type * as Server from "../domain/types.js";
import type * as Web from "../web/model.js";

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

export type Conformance = [
  Mutual<Server.OperationView, Web.OperationView>,
  Mutual<Server.CompensationView, Web.CompensationView>,
  Mutual<Server.ConnectorView, Web.ConnectorView>,
  Mutual<Server.StatusView, Web.StatusView>,
  Mutual<Server.SessionView, Web.SessionView>,
  Mutual<Server.MemberView, Web.MemberView>,
  Mutual<Server.PlanResponse, Web.PlanResponse>,
  Mutual<Server.ApproveResponse, Web.ApproveResponse>,
  Mutual<Server.CompensationPlanResponse, Web.CompensationPlanResponse>,
  Mutual<Server.CompensateResponse, Web.CompensateResponse>,
  Mutual<Server.ReconcileResponse, Web.ReconcileResponse>,
  Mutual<Server.ResolveResponse, Web.ResolveResponse>,
];
