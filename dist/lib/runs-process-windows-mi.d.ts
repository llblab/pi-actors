type NativeStage = 'application' | 'session' | 'input' | 'retrieval' | 'operation' | 'representation' | 'cleanup';
type RawTimestamp = {
    readonly profile: 'mi-timestamp-v1';
    readonly year: number;
    readonly month: number;
    readonly day: number;
    readonly hour: number;
    readonly minute: number;
    readonly second: number;
    readonly microseconds: number;
    readonly utc: number;
};
type RawRow = {
    readonly pid: number;
    readonly date: RawTimestamp;
    readonly exe: string;
    readonly cmd: string;
};
type DecodeOutcome = {
    readonly kind: 'decoded_unadmitted';
    readonly rows: readonly RawRow[];
} | {
    readonly kind: 'unusable';
    readonly reason: 'invalid_query' | 'invalid_wire' | 'unsupported_optional_fields';
} | {
    readonly kind: 'unusable';
    readonly reason: 'native_stage';
    readonly stage: NativeStage;
};
export declare function queryArguments(profile: unknown, pids: unknown): string[] | undefined;
type ProvenanceBinding = {
    readonly source_sha256: string;
    readonly executable_sha256: string;
    readonly executable_bytes: number;
    readonly originating_source_commit: string;
    readonly originating_build_job: string;
};
export declare function decodeProvenanceBinding(value: unknown): {
    readonly kind: 'decoded_binding_unadmitted';
    readonly binding: ProvenanceBinding;
} | {
    readonly kind: 'unusable';
    readonly reason: 'invalid_binding';
};
export declare function decodeResponse(bytes: Uint8Array, profile: unknown, pids: unknown): DecodeOutcome;
export {};
