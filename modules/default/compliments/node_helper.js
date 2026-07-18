const express = require("express");
const Log = require("logger");
const NodeHelper = require("node_helper");

const DEFAULT_MINUTES = 30;

/**
 *
 * @param value
 */
function normalizeNewlines (value) {
	return String(value).replace(/\\n/g, "\n");
}

/**
 *
 * @param text
 * @param secondLine
 */
function buildOverrideMessage (text, secondLine) {
	let message = normalizeNewlines(text);
	if (secondLine !== undefined && secondLine !== null && secondLine !== "") {
		message += `\n${normalizeNewlines(secondLine)}`;
	}
	return message;
}

module.exports = NodeHelper.create({
	// { message: string, expiresAt: number } — in-memory only, not persisted
	pushedOverride: null,

	start () {
		Log.info(`Starting node_helper for: ${this.name}`);

		this.expressApp.use(`/${this.name}/override`, express.json());

		this.expressApp.post(`/${this.name}/override`, (req, res) => {
			const { text, secondLine, minutes } = req.body;

			if (text === undefined || text === null || text === "") {
				this.pushedOverride = null;
				Log.info(`[${this.name}] Cleared pushed override`);
				this.notifyOverride();
				res.json({ status: "ok", override: null });
				return;
			}

			const mins = Number(minutes) > 0 ? Number(minutes) : DEFAULT_MINUTES;
			const expiresAt = Date.now() + mins * 60 * 1000;
			const message = buildOverrideMessage(text, secondLine);
			this.pushedOverride = { message, expiresAt };

			Log.info(`[${this.name}] Pushed override for ${mins}m: ${this.pushedOverride.message}`);
			this.notifyOverride();
			res.json({
				status: "ok",
				message: this.pushedOverride.message,
				expiresAt: this.pushedOverride.expiresAt,
				minutes: mins
			});
		});

		this.expressApp.get(`/${this.name}/override`, (req, res) => {
			res.json({ override: this.getActiveOverride() });
		});

		setInterval(() => this.expireIfNeeded(), 60 * 1000);
	},

	getActiveOverride () {
		if (!this.pushedOverride) return null;
		if (Date.now() >= this.pushedOverride.expiresAt) {
			this.pushedOverride = null;
			return null;
		}
		return {
			message: this.pushedOverride.message,
			expiresAt: this.pushedOverride.expiresAt
		};
	},

	expireIfNeeded () {
		const hadOverride = !!this.pushedOverride;
		const active = this.getActiveOverride();
		if (hadOverride && !active) {
			Log.info(`[${this.name}] Pushed override expired`);
			this.notifyOverride();
		}
	},

	notifyOverride () {
		this.sendSocketNotification("COMPLIMENT_OVERRIDE", this.getActiveOverride());
	},

	socketNotificationReceived (notification) {
		if (notification === "GET_COMPLIMENT_OVERRIDE") {
			this.notifyOverride();
		}
	}
});
