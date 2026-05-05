import type { Env } from '../index';

interface DailyStatsEntry {
	new_users: number;
	messages: number;
}

interface DailyStatsItem extends DailyStatsEntry {
	date: string;
}

interface StatsPayload {
	total_users: number;
	total_messages: number;
	top_active_servers: unknown[];
	daily_stats: DailyStatsItem[];
}

/**
 * Fetches aggregate usage stats for administrative dashboards.
 */
export async function fetchStatsPayload(env: Env): Promise<StatsPayload> {
	const totalUsers = await env.DB.prepare(`SELECT count(*) as total FROM devices`).first('total');
	const totalMessages = await env.DB.prepare(`SELECT coalesce(sum(message_count), 0) as total FROM message_stats`).first(
		'total',
	);

	const userStats = await env.DB.prepare(
		`
        SELECT date(created_at) as date, count(*) as count 
        FROM devices 
        GROUP BY date
        ORDER BY date DESC
        LIMIT 30
    `,
	).all();

	const messageStats = await env.DB.prepare(
		`
        SELECT date, message_count as count 
        FROM message_stats 
        ORDER BY date DESC
        LIMIT 30
    `,
	).all();

	const topServers = await env.DB.prepare(
		`
        SELECT server_id, message_count as count
        FROM servers
        ORDER BY message_count DESC
        LIMIT 10
    `,
	).all();

	const dailyStats: Record<string, DailyStatsEntry> = {};

	for (const row of userStats.results) {
		const date = row.date as string;
		if (!dailyStats[date]) {
			dailyStats[date] = { new_users: 0, messages: 0 };
		}
		dailyStats[date].new_users = Number(row.count);
	}

	for (const row of messageStats.results) {
		const date = row.date as string;
		if (!dailyStats[date]) {
			dailyStats[date] = { new_users: 0, messages: 0 };
		}
		dailyStats[date].messages = Number(row.count);
	}

	const sortedDailyStats = Object.entries(dailyStats)
		.sort(([dateA], [dateB]) => dateB.localeCompare(dateA))
		.map(([date, stats]) => ({ date, ...stats }));

	return {
		total_users: Number(totalUsers || 0),
		total_messages: Number(totalMessages || 0),
		top_active_servers: topServers.results,
		daily_stats: sortedDailyStats,
	};
}
