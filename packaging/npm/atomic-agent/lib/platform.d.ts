// Types of platform.js, for the release-matrix test (scripts/npm-packaging.test.ts).
export declare const SCOPE: string;
export declare const SLUGS: readonly string[];
export declare function platformPackageName(slug: string): string;
export declare function executableName(platform: string): string;
export declare function slugFor(platform: string, arch: string): string | undefined;
