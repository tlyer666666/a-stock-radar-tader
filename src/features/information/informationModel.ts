export type InformationTab = "all" | "flash" | "announcement";
export const informationTabs: { id: InformationTab; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "flash", label: "市场资讯" },
  { id: "announcement", label: "公司公告" }
];
export function resolveInformationCenterRoute(view: "news" | "announcements", informationTab: InformationTab = "all") {
  return { view: "news" as const, informationTab: view === "announcements" ? "announcement" as const : informationTab };
}
