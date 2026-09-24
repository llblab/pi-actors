/**
 * Run delivery lineage.
 * Zones: inherited coordinator root, parent Run generation, delivery-tree filtering
 * Owns durable completion ancestry; excludes delivery persistence and Pi scheduling.
 */
const DELIVERY_OWNER_ENV = "PI_ACTORS_DELIVERY_OWNER_ID";
const PARENT_RUN_ENV = "PI_ACTORS_DELIVERY_PARENT_RUN";
const PARENT_INSTANCE_ENV = "PI_ACTORS_DELIVERY_PARENT_INSTANCE";
const PARENT_STATE_DIR_ENV = "PI_ACTORS_DELIVERY_PARENT_STATE_DIR";
function nonEmpty(value) {
    const text = value?.trim();
    return text || undefined;
}
export function inheritedRunDeliveryLineage(ownerId, env = process.env) {
    const localOwner = nonEmpty(ownerId);
    if (!localOwner)
        return undefined;
    const deliveryOwner = nonEmpty(env[DELIVERY_OWNER_ENV]) ?? localOwner;
    const run = nonEmpty(env[PARENT_RUN_ENV]);
    const runInstanceId = nonEmpty(env[PARENT_INSTANCE_ENV]);
    const stateDir = nonEmpty(env[PARENT_STATE_DIR_ENV]);
    const completeParent = run && runInstanceId && stateDir
        ? { run, run_instance_id: runInstanceId, state_dir: stateDir }
        : undefined;
    if ((run || runInstanceId || stateDir) && !completeParent) {
        throw new Error("Inherited Run delivery parent lineage is incomplete");
    }
    return {
        delivery_owner_id: deliveryOwner,
        ...(completeParent ? { delivery_parent: completeParent } : {}),
    };
}
export function runDeliveryChildEnv(lineage, parent, env = process.env) {
    return {
        ...env,
        [DELIVERY_OWNER_ENV]: lineage.delivery_owner_id,
        [PARENT_RUN_ENV]: parent.run,
        [PARENT_INSTANCE_ENV]: parent.run_instance_id,
        [PARENT_STATE_DIR_ENV]: parent.state_dir,
    };
}
export function getProcessDeliveryOwnerId(env = process.env) {
    return nonEmpty(env[DELIVERY_OWNER_ENV]);
}
