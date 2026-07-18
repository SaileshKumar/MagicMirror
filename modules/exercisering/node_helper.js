const path = require("node:path");
const express = require("express");
const Log = require("logger");
const NodeHelper = require("node_helper");

const WORKOUTS = require("./workouts.json");

// Build alias → canonical name lookup: { "functional strength training": "traditional strength training", ... }
const ALIAS_MAP = {};
for (const w of WORKOUTS) {
	for (const alias of (w.aliases || [])) {
		ALIAS_MAP[alias.toLowerCase()] = w.name;
	}
}

function normalizeWorkoutType (raw) {
	const lower = raw.toLowerCase().trim();
	return ALIAS_MAP[lower] ?? lower;
}

/**
 * Parse Apple's duration fragment (between "for " and " today"), e.g.
 * "57 minutes, 44 seconds", "1 hour, 2 minutes", "30 minutes".
 * Minutes-only regex used to mis-read "1 hour, 2 minutes" as 2 minutes or fail entirely.
 */
function parseAppleForClauseToMinutes (fragment) {
	let total = 0;
	const hours = fragment.match(/(\d+)\s+hours?/i);
	const minutes = fragment.match(/(\d+)\s+minutes?/i);
	if (hours) total += parseInt(hours[1], 10) * 60;
	if (minutes) total += parseInt(minutes[1], 10);
	return total;
}

/** "Jul 14, 2026" → "2026-07-14", or null if unparseable */
function parseProviderDate (raw) {
	const d = new Date(raw.trim());
	if (Number.isNaN(d.getTime())) return null;
	return d.toLocaleDateString("en-CA");
}

/**
 * Parse workoutDescriptions into today's workouts.
 * New provider: "Strength Training · Jul 14, 2026" (one per line; mins unknown → null)
 * Legacy Apple: "Walking, for 30 minutes today at 8:39 PM..."
 */
function parseTodayWorkouts (descriptionsText, today) {
	const todayWorkouts = [];

	// New format: "Activity · Mon DD, YYYY"
	const newRe = /^(.+?)\s*·\s*(.+)$/gmu;
	let match;
	let sawNewFormat = false;
	while ((match = newRe.exec(descriptionsText)) !== null) {
		sawNewFormat = true;
		const type = normalizeWorkoutType(match[1].trim());
		const date = parseProviderDate(match[2]);
		if (type && date === today) {
			todayWorkouts.push({ type, mins: null });
		}
	}
	if (sawNewFormat) return todayWorkouts;

	// Legacy Apple Health wording
	const appleRe = /^(.+?),\s*for\s+(.+?)\s+today\b/gimu;
	while ((match = appleRe.exec(descriptionsText)) !== null) {
		const type = normalizeWorkoutType(match[1].trim());
		const mins = parseAppleForClauseToMinutes(match[2]);
		if (type && mins > 0) todayWorkouts.push({ type, mins });
	}
	return todayWorkouts;
}

module.exports = NodeHelper.create({
	// { "Sailesh": { workouts: ["walking"], date: "2026-04-05", lastUpdated: 17... } }
	userData: {},

	start () {
		Log.info(`Starting node_helper for: ${this.name}`);

		// Detect day rollover and push a fresh (empty) payload so the display clears at midnight
		let lastDate = new Date().toLocaleDateString("en-CA");
		setInterval(() => {
			const today = new Date().toLocaleDateString("en-CA");
			if (today !== lastDate) {
				lastDate = today;
				Log.info(`[${this.name}] Day rolled over to ${today}, refreshing display`);
				this.sendSocketNotification("EXERCISE_DATA", this.getPayload());
			}
		}, 60 * 1000);

		const mdiPath = path.resolve(global.root_path, "node_modules/@mdi/font");
		this.expressApp.use(`/${this.name}/mdi`, express.static(mdiPath));

		this.expressApp.use(`/${this.name}/data`, express.json());

		this.expressApp.post(`/${this.name}/data`, (req, res) => {
			Log.info(`[${this.name}] POST body: ${JSON.stringify(req.body, null, 2)}`);

			const { user, workoutDescriptions, exerciseMinutes } = req.body;

			if (!user || typeof user !== "string") {
				res.status(400).json({ error: "user (string) is required" });
				return;
			}

			const today = new Date().toLocaleDateString("en-CA");
			const rawMinutes = Number(exerciseMinutes) || 0;

			// Flatten workoutDescriptions into one string (handles both string and array)
			const descriptionsText = Array.isArray(workoutDescriptions)
				? workoutDescriptions.join("\n")
				: workoutDescriptions || "";

			const todayWorkouts = parseTodayWorkouts(descriptionsText, today);

			// Effective minutes: prefer exerciseMinutes; fall back to summed description mins (legacy)
			const sumDescriptionMinutes = todayWorkouts.reduce((s, w) => s + (w.mins || 0), 0);
			const effectiveMinutes = Math.max(rawMinutes, sumDescriptionMinutes);

			Log.info(`[${this.name}] ${user}: exerciseMinutes=${rawMinutes}, sumDescriptionMinutes=${sumDescriptionMinutes}, effectiveMinutes=${effectiveMinutes}`);

			// Build icon list: group by type. New format (mins null) counts every occurrence;
			// legacy format only counts workouts with mins > 5 as significant duplicates.
			const typeBuckets = {};
			for (const w of todayWorkouts) {
				if (!typeBuckets[w.type]) typeBuckets[w.type] = [];
				typeBuckets[w.type].push(w.mins);
			}

			const allWorkouts = [];
			for (const [type, minsList] of Object.entries(typeBuckets)) {
				const significantCount = minsList.filter((m) => m === null || m > 5).length;
				const iconCount = significantCount > 1 ? significantCount : 1;
				for (let i = 0; i < iconCount; i++) allWorkouts.push(type);
			}

			this.userData[user] = {
				workouts: allWorkouts,
				exerciseMinutes: effectiveMinutes,
				date: today,
				lastUpdated: Date.now()
			};

			Log.info(`[${this.name}] ${user}: ${allWorkouts.join(", ") || "(none)"} — ${effectiveMinutes}m (${today})`);
			this.sendSocketNotification("EXERCISE_DATA", this.getPayload());
			res.json({ status: "ok", user, workouts: allWorkouts, exerciseMinutes: effectiveMinutes });
		});

		this.expressApp.get(`/${this.name}/data`, (req, res) => {
			res.json(this.getPayload());
		});
	},

	getPayload () {
		const today = new Date().toLocaleDateString("en-CA");
		const result = {};
		for (const [user, data] of Object.entries(this.userData)) {
			result[user] = data.date === today ? data : { workouts: [], exerciseMinutes: 0, date: today, lastUpdated: null };
		}
		return result;
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "GET_EXERCISE_DATA") {
			// Seed any configured default users that haven't posted yet
			if (payload && Array.isArray(payload.users)) {
				const today = new Date().toLocaleDateString("en-CA");
				for (const user of payload.users) {
					if (!this.userData[user]) {
						this.userData[user] = { workouts: [], exerciseMinutes: 0, date: today, lastUpdated: null };
					}
				}
			}
			this.sendSocketNotification("EXERCISE_DATA", this.getPayload());
		}
	}
});
