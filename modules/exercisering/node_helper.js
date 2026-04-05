const path = require("node:path");
const express = require("express");
const Log = require("logger");
const NodeHelper = require("node_helper");

const WORKOUTS = require("./workouts.json");

// Build alias → canonical name lookup: { "functional strength training": "traditional strength training", ... }
const ALIAS_MAP = {};
for (const w of WORKOUTS) {
	for (const alias of w.aliases) {
		ALIAS_MAP[alias.toLowerCase()] = w.name;
	}
}

function normalizeWorkoutType (raw) {
	const lower = raw.toLowerCase().trim();
	return ALIAS_MAP[lower] ?? lower;
}

module.exports = NodeHelper.create({
	// { "Sailesh": { workouts: ["walking"], date: "2026-04-05", lastUpdated: 17... } }
	userData: {},

	start () {
		Log.info(`Starting node_helper for: ${this.name}`);

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

			const today = new Date().toISOString().slice(0, 10);
			const minutes = Number(exerciseMinutes) || 0;

			// Parse types from Personal Best description strings
			// e.g. "Walking, for 30 minutes today at 5:23 PM..." → "walking"
			// Only include descriptions that mention "today" (case-insensitive)
			const descriptions = Array.isArray(workoutDescriptions)
				? workoutDescriptions
				: workoutDescriptions ? [workoutDescriptions] : [];

			const parsedTypes = descriptions
				.filter((d) => typeof d === "string" && d.toLowerCase().includes("today"))
				.map((d) => normalizeWorkoutType(d.split(",")[0]))
				.filter(Boolean);

			const allWorkouts = [...new Set(parsedTypes)];

			this.userData[user] = {
				workouts: allWorkouts,
				exerciseMinutes: minutes,
				date: today,
				lastUpdated: Date.now()
			};

			Log.info(`[${this.name}] ${user}: ${allWorkouts.join(", ") || "(none)"} — ${minutes}m (${today})`);
			this.sendSocketNotification("EXERCISE_DATA", this.getPayload());
			res.json({ status: "ok", user, workouts: allWorkouts, exerciseMinutes: minutes });
		});

		this.expressApp.get(`/${this.name}/data`, (req, res) => {
			res.json(this.getPayload());
		});
	},

	getPayload () {
		const today = new Date().toISOString().slice(0, 10);
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
				const today = new Date().toISOString().slice(0, 10);
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
