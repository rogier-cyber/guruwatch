-- Rogier (15 nov): alleen de zaterdagmail, geen dagelijkse ochtendbriefing meer.
UPDATE user_settings SET briefing = false WHERE briefing;
