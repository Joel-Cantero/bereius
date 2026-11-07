export interface GoogleCalendarBookingSyncView {
  status: "pending" | "failed" | "created" | "none";
  lastFailureCode: string | null;
  eventId: string | null;
}