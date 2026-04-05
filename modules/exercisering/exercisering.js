Module.register("exercisering", {
	defaults: {},

	workoutIcons: {},
	userData: {},

	start () {
		Log.info(`Starting module: ${this.name}`);
		this.loadWorkouts().then(() => {
			this.sendSocketNotification("GET_EXERCISE_DATA", { users: this.config.users || [] });
		});
	},

	async loadWorkouts () {
		try {
			const res = await fetch("/modules/exercisering/workouts.json");
			const workouts = await res.json();
			for (const w of workouts) {
				this.workoutIcons[w.name] = w.icon;
			}
		} catch (e) {
			Log.error(`[${this.name}] Failed to load workouts.json: ${e.message}`);
		}
	},

	getStyles () {
		return [
			"exercisering.css",
			"/exercisering/mdi/css/materialdesignicons.min.css"
		];
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "EXERCISE_DATA") {
			this.userData = payload;
			this.updateDom(600);
		}
	},

	getDom () {
		const wrapper = document.createElement("div");
		wrapper.className = "exercise-wrapper";

		const users = Object.entries(this.userData);
		if (users.length === 0) {
			return wrapper;
		}

		for (const [name, data] of users) {
			const row = document.createElement("div");
			row.className = "exercise-row";

			const nameEl = document.createElement("span");
			nameEl.className = "exercise-name bright";
			nameEl.textContent = name;
			row.appendChild(nameEl);

			const icons = document.createElement("span");
			icons.className = "exercise-icons";

			if (data.workouts.length === 0) {
				// empty — show nothing
			} else {
				for (const w of data.workouts) {
					const icon = document.createElement("i");
					icon.className = this.workoutIcons[w] || "mdi mdi-trophy";
					icon.title = w;
					icons.appendChild(icon);
				}
			}

			row.appendChild(icons);

			const timeEl = document.createElement("span");
			timeEl.className = "exercise-time dimmed";
			timeEl.textContent = `${data.exerciseMinutes || 0}m`;
			row.appendChild(timeEl);

			wrapper.appendChild(row);
		}

		return wrapper;
	}
});
