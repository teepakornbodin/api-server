// lib/types.ts
export type PlanItemType = "travel" | "meal" | "attraction" | "checkin" | "checkout" | "shopping";

export interface PlanItem {
  time: string;
  name: string;
  type: PlanItemType;
  location?: string;
  estCost?: number;
  duration?: string;
}

export interface PlanDay {
  day: string;
  label: string;
  items: PlanItem[];
}

export interface Plan {
  title: string;
  dates: string | null;
  participants: number | null;
  totalBudget: number | null;
  overview: {
    destinations: string[];
    accommodation?: string;
    transportation?: string;
    totalDistance?: string;
  };
  itinerary: PlanDay[];
  budgetBreakdown: {
    transportation: number;
    accommodation: number;
    attractions: number;
    meals: number;
    shopping: number;
    miscellaneous: number;
  };
  tips: string[];
}

export interface VoteSummary {
  name: string;
  location?: string;
  estimated_cost?: number;
  duration?: string;
}

export interface SnapshotPayload {
  constraints?: {
    group_size?: number;
    max_budget_per_person?: number;
    travel_styles?: string[];
    preferred_provinces?: string[];
    date_window?: { all_dates?: string[] };
  };
  votes_summary?: VoteSummary[];
}
