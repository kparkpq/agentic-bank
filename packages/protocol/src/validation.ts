import AjvImport, { type ErrorObject, type ValidateFunction } from "ajv";

type AjvConstructor = new (options?: {
  allErrors?: boolean;
  strict?: boolean;
  strictTypes?: boolean;
  validateFormats?: boolean;
  unicodeRegExp?: boolean;
}) => {
  addFormat(name: string, definition: { type: string; validate: (value: string) => boolean }): unknown;
  addSchema(schema: object): unknown;
  compile(schema: object): ValidateFunction;
};

const Ajv = (AjvImport as unknown as { default?: AjvConstructor }).default ?? (AjvImport as unknown as AjvConstructor);
import protocolSchema from "../schemas/ec-v0.schema.json" with { type: "json" };
import type {
  AuthorizationDecision,
  ClosureProof,
  ConsumptionRecord,
  DecisionInputSnapshot,
  ExecutionCapsule,
  ExecutionReceipt,
  InterpreterDescriptor,
  LedgerObservation,
  Mandate,
  PolicyArtifact,
  ProposedAction,
  SchemaObjectType,
  Signature,
  SignedEnvelope,
  TransferEffect,
  TrustRootManifest,
  TrustStore,
  ValidationIssue,
  ValidationResult,
} from "./types.js";

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const POSITIVE_INTEGER = /^[1-9]\d{0,15}$/u;
const NON_NEGATIVE_INTEGER = /^(?:0|[1-9]\d{0,15})$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

function isCanonicalTimestamp(value: string): boolean {
  return (
    CANONICAL_TIMESTAMP.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isPositiveSafeInteger(value: string): boolean {
  return POSITIVE_INTEGER.test(value) && BigInt(value) <= MAX_SAFE_INTEGER;
}

function isNonNegativeSafeInteger(value: string): boolean {
  return NON_NEGATIVE_INTEGER.test(value) && BigInt(value) <= MAX_SAFE_INTEGER;
}

function isIdentifier(value: string): boolean {
  return value.trim() === value && !CONTROL_CHARACTER.test(value);
}

function isAccountId(value: string): boolean {
  return isIdentifier(value) && value.normalize("NFC") === value;
}

const ajv = new Ajv({
  allErrors: true,
  strict: true,
  strictTypes: false,
  validateFormats: true,
  unicodeRegExp: true,
});

ajv.addFormat("ec-identifier", { type: "string", validate: isIdentifier });
ajv.addFormat("ec-account-id", { type: "string", validate: isAccountId });
ajv.addFormat("ec-timestamp", { type: "string", validate: isCanonicalTimestamp });
ajv.addFormat("ec-positive-integer", { type: "string", validate: isPositiveSafeInteger });
ajv.addFormat("ec-amount", { type: "string", validate: isPositiveSafeInteger });
ajv.addFormat("ec-nonnegative-integer", { type: "string", validate: isNonNegativeSafeInteger });
ajv.addSchema(protocolSchema);

function compileDefinition(name: string): ValidateFunction {
  return ajv.compile({
    $ref: `${protocolSchema.$id}#/definitions/${name}`,
  });
}

export const VALIDATOR_REGISTRY = Object.freeze({
  TrustRootManifest: compileDefinition("trustRootManifest"),
  TrustStore: compileDefinition("trustStore"),
  Mandate: compileDefinition("mandate"),
  ProposedAction: compileDefinition("proposedAction"),
  TransferEffect: compileDefinition("transferEffect"),
  PolicyArtifact: compileDefinition("policyArtifact"),
  InterpreterDescriptor: compileDefinition("interpreterDescriptor"),
  DecisionInputSnapshot: compileDefinition("decisionInputSnapshot"),
  AuthorizationDecision: compileDefinition("authorizationDecision"),
  ExecutionCapsule: compileDefinition("executionCapsule"),
  ConsumptionRecord: compileDefinition("consumptionRecord"),
  ExecutionReceipt: compileDefinition("executionReceipt"),
  LedgerObservation: compileDefinition("ledgerObservation"),
  ClosureProof: compileDefinition("closureProof"),
  Signature: compileDefinition("signature"),
  SignedEnvelope: compileDefinition("signedEnvelope"),
}) satisfies Readonly<Record<SchemaObjectType, ValidateFunction>>;

export const SCHEMA_OBJECT_TYPES = Object.freeze(
  Object.keys(VALIDATOR_REGISTRY).sort(),
) as readonly SchemaObjectType[];

const schemaObjectTypeSet: ReadonlySet<string> = new Set(SCHEMA_OBJECT_TYPES);

function pointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function issuePath(error: ErrorObject): string {
  const instance = error.instancePath || "";
  if (error.keyword === "required" && typeof error.params.missingProperty === "string") {
    return `${instance}/${pointerToken(error.params.missingProperty)}`;
  }
  return instance || "/";
}

export type ValidationTypeMap = {
  TrustRootManifest: TrustRootManifest;
  TrustStore: TrustStore;
  Mandate: Mandate;
  ProposedAction: ProposedAction;
  TransferEffect: TransferEffect;
  PolicyArtifact: PolicyArtifact;
  InterpreterDescriptor: InterpreterDescriptor;
  DecisionInputSnapshot: DecisionInputSnapshot;
  AuthorizationDecision: AuthorizationDecision;
  ExecutionCapsule: ExecutionCapsule;
  ConsumptionRecord: ConsumptionRecord;
  ExecutionReceipt: ExecutionReceipt;
  LedgerObservation: LedgerObservation;
  ClosureProof: ClosureProof;
  Signature: Signature;
  SignedEnvelope: SignedEnvelope<unknown>;
};

export function validateObject<K extends keyof ValidationTypeMap>(
  objectType: K,
  input: unknown,
): ValidationResult<ValidationTypeMap[K]>;
export function validateObject(objectType: string, input: unknown): ValidationResult<unknown>;
export function validateObject(objectType: string, input: unknown): ValidationResult<unknown> {
  if (!schemaObjectTypeSet.has(objectType)) {
    return {
      valid: false,
      issues: [
        {
          object_type: "Unknown",
          path: "/object_type",
          keyword: "unsupported",
          message: `unsupported object type: ${objectType}`,
        },
      ],
    };
  }

  const typedObjectType = objectType as SchemaObjectType;
  const validator = VALIDATOR_REGISTRY[typedObjectType];
  if (validator(input)) {
    return { valid: true, value: input };
  }
  return {
    valid: false,
    issues: (validator.errors ?? []).map((error) => ({
      object_type: typedObjectType,
      path: issuePath(error),
      keyword: error.keyword,
      message: error.message ?? "schema validation failed",
    })),
  };
}
