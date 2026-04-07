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

			// One regex pass: per line, match workout type + minutes only when "today" appears on that line
			// e.g. "Walking, for 30 minutes, 59 seconds today at 8:39 PM..."
			const todayWorkouts = [];
			const re = /^(.+?),\s*for\s+(\d+)\s+minute.*today/gim;
			let match;
			while ((match = re.exec(descriptionsText)) !== null) {
				const type = normalizeWorkoutType(match[1].trim());
				const mins = parseInt(match[2], 10);
				if (type) todayWorkouts.push({ type, mins });
			}

			// Effective minutes: max of Apple Health exercise minutes and sum of description minutes
			const sumDescriptionMinutes = todayWorkouts.reduce((s, w) => s + w.mins, 0);
			const effectiveMinutes = Math.max(rawMinutes, sumDescriptionMinutes);

			Log.info(`[${this.name}] ${user}: exerciseMinutes=${rawMinutes}, sumDescriptionMinutes=${sumDescriptionMinutes}, effectiveMinutes=${effectiveMinutes}`);

			// Build icon list: for each workout type, count occurrences where mins > 5.
			// Show that many icons so e.g. two separate walks each appear.
			const typeBuckets = {};
			for (const w of todayWorkouts) {
				if (!typeBuckets[w.type]) typeBuckets[w.type] = [];
				typeBuckets[w.type].push(w.mins);
			}

			const allWorkouts = [];
			for (const [type, minsList] of Object.entries(typeBuckets)) {
				const significantCount = minsList.filter((m) => m > 5).length;
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
