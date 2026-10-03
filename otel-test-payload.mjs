/**
 * The smallest valid OTLP bodies, used by `POST /api/settings/otel/test` to
 * check a destination end to end: one span and one counter data point, with no
 * workflow data in them.
 */
import { randomBytes } from "node:crypto";
import { TEMPORALITY_DELTA, SPAN_KIND_INTERNAL, STATUS_OK, attrs, resourceBlock, scopeBlock, toUnixNano } from "./otel.mjs";

export function buildTestPayloads({ orgId = null, serviceVersion = null, now = new Date() } = {}) {
	const end = toUnixNano(now);
	const start = toUnixNano(new Date(now.getTime() - 1));
	const resource = resourceBlock({ org: orgId, serviceVersion });
	const scope = scopeBlock({ serviceVersion });
	return {
		traces: {
			resourceSpans: [
				{
					resource,
					scopeSpans: [
						{
							scope,
							spans: [
								{
									traceId: randomBytes(16).toString("hex"),
									spanId: randomBytes(8).toString("hex"),
									name: "target.otel.test",
									kind: SPAN_KIND_INTERNAL,
									startTimeUnixNano: start,
									endTimeUnixNano: end,
									attributes: attrs({ "target.test": true }),
									status: { code: STATUS_OK },
								},
							],
						},
					],
				},
			],
		},
		metrics: {
			resourceMetrics: [
				{
					resource,
					scopeMetrics: [
						{
							scope,
							metrics: [
								{
									name: "target.otel.test",
									description: "Connectivity check sent from the settings page",
									unit: "1",
									sum: {
										aggregationTemporality: TEMPORALITY_DELTA,
										isMonotonic: true,
										dataPoints: [{ attributes: attrs({ "target.test": true }), startTimeUnixNano: start, timeUnixNano: end, asInt: "1" }],
									},
								},
							],
						},
					],
				},
			],
		},
	};
}
