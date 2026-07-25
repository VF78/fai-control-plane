CREATE FUNCTION "public"."sanitize_inbound_event_payload_0001"("input" jsonb) RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
	"result" jsonb;
BEGIN
	IF jsonb_typeof("input") = 'object' THEN
		SELECT coalesce(jsonb_object_agg("entry"."key", "public"."sanitize_inbound_event_payload_0001"("entry"."value")), '{}'::jsonb)
		INTO "result"
		FROM jsonb_each("input") AS "entry"
		WHERE regexp_replace(lower("entry"."key"), '[^a-z0-9]', '', 'g') <> ALL (ARRAY[
			'authorization', 'proxyauthorization', 'cookie', 'setcookie',
			'headers', 'httpheaders', 'requestheaders', 'rawheaders',
			'apikey', 'token', 'accesstoken', 'refreshtoken', 'clientsecret',
			'password', 'passwd', 'secret', 'signingsecret', 'privatekey',
			'credential', 'credentials', 'signature', 'hubsignature',
			'hubsignature256', 'xhubsignature', 'xhubsignature256',
			'stripesignature'
		])
		AND regexp_replace(lower("entry"."key"), '[^a-z0-9]', '', 'g') !~ '(apikey|token|accesstoken|refreshtoken|clientsecret|password|passwd|secret|privatekey|credential|credentials|signature)$';

		RETURN "result";
	END IF;

	IF jsonb_typeof("input") = 'array' THEN
		SELECT coalesce(jsonb_agg("public"."sanitize_inbound_event_payload_0001"("element"."value") ORDER BY "element"."ordinality"), '[]'::jsonb)
		INTO "result"
		FROM jsonb_array_elements("input") WITH ORDINALITY AS "element"("value", "ordinality");

		RETURN "result";
	END IF;

	RETURN "input";
END;
$$;--> statement-breakpoint
UPDATE "incoming_events"
SET "payload" = CASE
	WHEN jsonb_typeof("payload") = 'object' THEN "public"."sanitize_inbound_event_payload_0001"("payload")
	ELSE '{}'::jsonb
END;--> statement-breakpoint
DROP FUNCTION "public"."sanitize_inbound_event_payload_0001"(jsonb);--> statement-breakpoint
ALTER TABLE "incoming_events" RENAME COLUMN "payload" TO "sanitized_payload";--> statement-breakpoint
ALTER TABLE "incoming_events" ADD COLUMN "verification" jsonb DEFAULT '{"outcome":"unverified","method":"none"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "incoming_events" DROP COLUMN "headers";--> statement-breakpoint
ALTER TABLE "incoming_events" ADD CONSTRAINT "incoming_events_verification_envelope_valid" CHECK ("incoming_events"."verification" in (
        '{"outcome":"unverified","method":"none"}'::jsonb,
        '{"outcome":"verified","method":"hmac-sha256"}'::jsonb,
        '{"outcome":"verified","method":"signature-sha256"}'::jsonb,
        '{"outcome":"verified","method":"shared-token"}'::jsonb,
        '{"outcome":"rejected","method":"hmac-sha256"}'::jsonb,
        '{"outcome":"rejected","method":"signature-sha256"}'::jsonb,
        '{"outcome":"rejected","method":"shared-token"}'::jsonb
      ));--> statement-breakpoint
ALTER TABLE "incoming_events" ADD CONSTRAINT "incoming_events_sanitized_payload_object" CHECK (jsonb_typeof("incoming_events"."sanitized_payload") = 'object');
