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
/**
 * Complete-helper manifest claim. Bounded reading, exact-key schema and closed lexemes only; a valid
 * manifest is integrity/provenance input, never executable authenticity, an approved asset or activation.
 */
type HelperManifest = {
    readonly helper_version: string;
    readonly architecture: 'windows-x64';
    readonly protocol: 'native-mi-v1';
    readonly profiles: readonly ['scalar', 'shared'];
    readonly native_source_sha256: string;
    readonly executable_bytes: number;
    readonly executable_sha256: string;
    readonly toolchain: {
        readonly compiler: string;
        readonly sdk: string;
        readonly build_arguments: readonly string[];
    };
    readonly dependencies: readonly string[];
    readonly originating_source_commit: string;
    readonly originating_build_job: string;
};
type ManifestUnusable = {
    readonly kind: 'unusable';
    readonly reason: 'oversize_manifest' | 'invalid_manifest' | 'unsupported_manifest';
};
/** Bounded complete-manifest reader: one strict UTF-8 JSON document with an exact reviewed shape. */
export declare function readHelperManifest(bytes: Uint8Array): {
    readonly kind: 'manifest_unadmitted';
    readonly manifest: HelperManifest;
} | ManifestUnusable;
type HelperAssetLocation = {
    readonly kind: 'located';
    readonly helper_version: string;
    readonly manifest_url: URL;
    readonly executable_url: URL;
};
/**
 * Fixed versioned package-relative lookup. Never searches cwd, PATH or caller locations: the only base is
 * the sibling `native/` directory of this module's own `lib/` (source) or `dist/lib/` (compiled) home.
 */
export declare function resolveHelperAsset(moduleUrl: unknown, runtime: unknown, helperVersion: unknown): HelperAssetLocation | {
    readonly kind: 'unusable';
    readonly reason: 'unsupported_location' | 'unsupported_target' | 'unsupported_version';
};
/** Injected bounded reader: exact bytes for one fixed URL or nothing. Never a path, cwd or PATH lookup. */
export type HelperAssetReader = (url: URL, maximumBytes: number) => Uint8Array | undefined;
type HelperAssetOutcome = {
    readonly kind: 'asset_verified_unadmitted';
    readonly manifest: HelperManifest;
    readonly executable_sha256: string;
    readonly executable_bytes: number;
} | {
    readonly kind: 'unusable';
    readonly reason: 'missing_manifest' | 'oversize_manifest' | 'invalid_manifest' | 'unsupported_manifest' | 'version_mismatch' | 'missing_asset' | 'oversize_asset' | 'size_mismatch' | 'digest_mismatch';
};
/** Trusted exact-byte selection: bounded manifest read, exact declared size, then exact SHA-256 match. */
export declare function loadHelperAsset(location: HelperAssetLocation, read: HelperAssetReader): HelperAssetOutcome;
type HelperInvocation = {
    readonly kind: 'invocation_unadmitted';
    readonly command: string;
    readonly args: readonly string[];
    readonly options: {
        readonly shell: false;
        readonly windowsHide: true;
    };
} | {
    readonly kind: 'unusable';
    readonly reason: 'unsupported_executable' | 'invalid_query';
};
/** Shell-free invocation spec only: no spawn, retry, fallback or execution-policy bypass. */
export declare function helperInvocation(executablePath: unknown, profile: unknown, pids: unknown): HelperInvocation;
export {};
