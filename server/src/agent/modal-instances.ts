/**
 * Compatibility re-export. The authoritative server catalogue now lives in
 * modal/catalog.ts and is shared by execution, reservations, tools, and API.
 */
export {
  DEFAULT_INSTANCE_ID,
  MODAL_INSTANCE_IDS,
  MODAL_INSTANCES,
  resolveInstance,
  type ModalInstanceSpec,
} from "../modal/catalog.ts";
