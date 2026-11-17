// Shared types used by both the API routes and the browser.

export interface Member {
  id: number;
  name: string;
  initials: string;
  color: string;
}

export interface Initiative {
  id: string;
  name: string;
  url: string;
  listId: string;
  listName: string;
  status: string;            // ClickUp status name, e.g. "in build"
  statusColor: string;
  done: boolean;             // status type is closed/done
  priority: string;          // Urgent | High | Normal | Low | ''
  pillar: string;            // Pillar dropdown option name ('' if unset / no field)
  bigSwing: boolean;
  roadmapMonth: string;      // 'YYYY-MM' from the Target Month / Roadmap Month field, or ''
  roadmapStart: string;      // 'YYYY-MM-DD' from the "Roadmap Start Date" field, or ''
  roadmapEnd: string;        // 'YYYY-MM-DD' from the "Roadmap End Date" field, or ''
  sprint: string;            // Sprint field display value or ''
  testTargeting: string;     // "🧪 Test Targeting" text (comma-separated targets) or ''
  startDate: string;         // native ClickUp start date 'YYYY-MM-DD' or ''
  dueDate: string;           // native ClickUp due date 'YYYY-MM-DD' or ''
  owners: Member[];
  notes: string;             // markdown description
  tags: string[];
  createdAt: string;         // ISO
  /** Filterable ClickUp fields (ROCK, TACTIC, Task Category, …) → selected option names / people */
  attrs: Record<string, string[]>;
}

/** Fields the browser may send when creating / updating an initiative. */
export interface InitiativeInput {
  name?: string;
  listId?: string;           // create only
  status?: string;
  priority?: string;
  pillar?: string;
  bigSwing?: boolean;
  roadmapMonth?: string;
  roadmapStart?: string;
  roadmapEnd?: string;
  sprint?: string;
  testTargeting?: string;
  // NOTE: no startDate/dueDate — the app never writes ClickUp's native task dates.
  ownerId?: number | null;   // replaces all assignees with this one (null = none)
  notes?: string;
}

export interface StatusOption { name: string; color: string; type: string; done: boolean }
export interface FieldOption { id: string; name: string; color: string }

export interface ListMeta {
  id: string;
  name: string;
  url: string;
  color: string;                  // UI color for the list (used when there's no Pillar field)
  statuses: StatusOption[];
  fields: { pillar: boolean; roadmapMonth: boolean; roadmapStart: boolean; roadmapEnd: boolean; sprint: boolean; bigSwing: boolean; testTargeting: boolean };
  pillars: FieldOption[];
  sprintOptions: FieldOption[];   // empty when Sprint is free text (or missing)
  monthOptions: string[];         // 'YYYY-MM' values when the month field is a dropdown; empty = any month
}

export interface FilterField {
  label: string;                       // e.g. "ROCK"
  options: FieldOption[];              // union across lists (people fields: members)
  lists: string[];                     // list ids that have this field
}

export interface RoadmapMeta {
  lists: ListMeta[];
  filterFields: FilterField[];
  defaultListId: string;          // where "+ Add" creates tasks
  requestListId: string;          // where submitted requests are created
  pillars: FieldOption[];         // union across lists
  members: Member[];
  mock: boolean;
}

export interface RoadmapRequest {
  id: string;
  name: string;
  pillar: string;
  month: string;          // display label e.g. "November 2026"
  priority: string;
  submittedBy: string;
  notes: string;
  submittedAt: string;
  url: string;
}

export const PRIORITIES = ['Urgent', 'High', 'Normal', 'Low'] as const;
