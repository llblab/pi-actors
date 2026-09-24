/**
 * Run delivery lineage.
 * Zones: inherited coordinator root, parent Run generation, delivery-tree filtering
 * Owns durable completion ancestry; excludes delivery persistence and Pi scheduling.
 */
export interface RunDeliveryParent {
    run: string;
    run_instance_id: string;
    state_dir: string;
}
export interface RunDeliveryLineage {
    delivery_owner_id: string;
    delivery_parent?: RunDeliveryParent;
}
export declare function inheritedRunDeliveryLineage(ownerId: string | undefined, env?: NodeJS.ProcessEnv): RunDeliveryLineage | undefined;
export declare function runDeliveryChildEnv(lineage: RunDeliveryLineage, parent: RunDeliveryParent, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function getProcessDeliveryOwnerId(env?: NodeJS.ProcessEnv): string | undefined;
