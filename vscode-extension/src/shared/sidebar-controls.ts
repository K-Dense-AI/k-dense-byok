export type SidebarSkill = {
  id: string;
  name: string;
  description: string;
  author: string;
  license: string;
  compatibility: string;
};

export type SidebarControlAvailability = {
  modalConfigured: boolean;
  availableSkills: SidebarSkill[];
};

export function createDefaultSidebarControlAvailability(): SidebarControlAvailability {
  return {
    modalConfigured: false,
    availableSkills: [],
  };
}
