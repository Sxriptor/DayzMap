// Offline capture mission for DayZDiag_x64.exe (no server, no BattlEye, no signing). `npm run capture:plan`
// copies this file into @NasdaraCapture\NasdaraCapture.<world>\ next to plan.txt, and `npm run capture:run`
// starts the game on it. A camera walks the plan's points in order; at each point it waits for the world to
// stream in, then turns through the plan's headings and asks for one picture per heading.
// The game's own MakeScreenshot writes nothing in this build, so pictures are taken from outside: for each one
// the mission writes $profile:NasdaraCapture\shot.txt (the picture's CSV line: file, x, y, z, heading, pitch,
// fov) and holds still until capture:run has saved the window and deleted the file.
// $profile:NasdaraCapture\<world>_progress.txt holds "<plan> <next point>", so a restart carries on from there.
// The game quits when the plan is done unless the plan says "stay 1".

// One capture run: reads the plan, then one step per frame (OnUpdate) through a small state machine.
class NasdaraCapture
{
	static const string DIR = "$profile:NasdaraCapture";
	static const string SHOT = "$profile:NasdaraCapture/shot.txt";
	static const int MIN_FRAMES = 3; // frames to render after any camera change, however fast the game runs

	// Settings, from plan.txt's header (these defaults match `npm run capture:plan`).
	protected string m_Plan = "plan";
	protected int m_Headings = 6;
	protected float m_Fov = 0.96;     // field of view, radians, as the player's (fov= in <name>_settings.DayZProfile)
	protected float m_Pitch = 0;      // degrees, up positive
	protected float m_Height = 1.7;   // eye height above the ground or road, metres
	protected int m_FirstMs = 15000;  // world load before the first point
	protected int m_SettleMs = 600;   // after each move, for the new spot to stream in
	protected int m_TurnMs = 120;     // after each turn
	protected int m_Hour = 12;
	protected float m_Overcast = 0.2;
	protected float m_View = 3000;    // view distance, metres
	protected bool m_Stay;            // keep the game open when done

	protected ref array<vector> m_Points;
	protected int m_Point;
	protected int m_Heading;
	protected int m_Phase;    // 0 start, 1 settle at a new point, 2 aim, 3 picture asked for, 4 done
	protected int m_HoldUntil;
	protected int m_Frames;
	protected int m_Started;
	protected int m_StartPoint;
	protected int m_LastPercent = -1;
	protected int m_FrameCount;  // frames since the last report, for its frame rate
	protected int m_ReportTime;
	protected int m_Asked;    // when the current picture was asked for
	protected bool m_Warned;
	protected string m_World;
	protected string m_Prefix;
	protected vector m_Eye;
	protected Camera m_Camera;

	void NasdaraCapture()
	{
		m_Points = new array<vector>;
		MakeDirectory(DIR);
		DeleteFile(SHOT); // left over from a run stopped mid-picture
	}

	bool IsDone()
	{
		return m_Phase == 4;
	}

	void Step()
	{
		int now = GetGame().GetTime();
		m_Frames++;
		m_FrameCount++;
		if (m_Phase == 0) Start();
		else if (m_Phase == 3) AwaitPicture(now);
		else if (m_Frames >= MIN_FRAMES && now >= m_HoldUntil)
		{
			if (m_Phase == 1) Aim();
			else if (m_Phase == 2) Shoot();
		}
	}

	protected void Start()
	{
		GetGame().GetWorldName(m_World);
		m_World.ToLower();
		m_Prefix = DIR + "/" + m_World + "_";
		if (!ReadPlan()) return;
		m_Point = ReadProgress();
		m_StartPoint = m_Point;
		if (m_Point >= m_Points.Count())
		{
			Finish("plan " + m_Plan + " was already complete");
			return;
		}
		Print(string.Format("[NasdaraCapture] %1: plan %2, %3 points x %4 headings, starting at point %5", m_World, m_Plan, m_Points.Count(), m_Headings, m_Point));

		World world = GetGame().GetWorld();
		world.SetViewDistance(m_View);
		world.SetObjectViewDistance(m_View);
		Weather weather = GetGame().GetWeather();
		weather.MissionWeather(true);
		weather.GetOvercast().SetLimits(m_Overcast, m_Overcast);
		weather.GetOvercast().Set(m_Overcast, 0, 0);
		weather.GetRain().SetLimits(0, 0);
		weather.GetRain().Set(0, 0, 0);
		weather.GetSnowfall().SetLimits(0, 0);
		weather.GetSnowfall().Set(0, 0, 0);
		weather.GetFog().SetLimits(0, 0);
		weather.GetFog().Set(0, 0, 0);
		weather.SetWindSpeed(0);

		m_Camera = Camera.Cast(GetGame().CreateObject("staticcamera", m_Points[m_Point], true));
		if (!m_Camera)
		{
			Fail("cannot create the camera");
			return;
		}
		m_Camera.SetFOV(m_Fov);
		m_Camera.SetFocus(5.0, 0.0); // no depth of field
		m_Camera.SetActive(true);
		m_Started = GetGame().GetTime();
		MoveTo(m_FirstMs);
	}

	// Phase 1: the camera to the current point, then a hold for the spot to stream in.
	protected void MoveTo(int holdMs)
	{
		vector p = m_Points[m_Point];
		float ground = Math.Max(GetGame().SurfaceY(p[0], p[2]), GetGame().SurfaceRoadY(p[0], p[2]));
		m_Eye = Vector(p[0], ground + m_Height, p[2]);
		int year, month, day, hour, minute;
		GetGame().GetWorld().GetDate(year, month, day, hour, minute);
		GetGame().GetWorld().SetDate(year, month, day, m_Hour, 0); // the clock stands still: same light all run
		m_Camera.SetPosition(m_Eye);
		m_Heading = 0;
		LookAlong(0);
		Hold(1, holdMs);
	}

	// Phase 2: turn to the current heading (degrees clockwise from north).
	protected void Aim()
	{
		LookAlong(m_Heading * 360.0 / m_Headings);
		Hold(2, m_TurnMs);
	}

	protected void LookAlong(float heading)
	{
		float yaw = heading * Math.DEG2RAD;
		float lift = Math.Tan(m_Pitch * Math.DEG2RAD);
		m_Camera.LookAt(m_Eye + Vector(Math.Sin(yaw), lift, Math.Cos(yaw)) * 100);
	}

	// Phase 3: ask for the picture, then hold still until capture:run has taken it.
	protected void Shoot()
	{
		string file = string.Format("%1-%2-%3", m_Plan, m_Point, m_Heading);
		float heading = m_Heading * 360.0 / m_Headings;
		FileHandle f = OpenFile(SHOT, FileMode.WRITE);
		if (!f)
		{
			Fail("cannot write " + SHOT);
			return;
		}
		FPrintln(f, string.Format("%1,%2,%3,%4,%5,%6,%7", file, m_Eye[0], m_Eye[1], m_Eye[2], heading, m_Pitch, m_Fov));
		CloseFile(f);
		m_Asked = GetGame().GetTime();
		m_Phase = 3;
	}

	protected void AwaitPicture(int now)
	{
		if (!FileExist(SHOT))
		{
			Next();
			return;
		}
		if (m_Warned || now - m_Asked < 10000) return;
		m_Warned = true;
		Print("[NasdaraCapture] waiting for the picture: is npm run capture:run still running?");
	}

	protected void Next()
	{
		m_Heading++;
		if (m_Heading < m_Headings)
		{
			Aim(); // same spot: straight on to the next heading
			return;
		}
		m_Point++;
		WriteProgress();
		Report();
		if (m_Point >= m_Points.Count())
		{
			Finish("plan " + m_Plan + " complete");
			return;
		}
		MoveTo(m_SettleMs);
	}

	protected void Hold(int phase, int ms)
	{
		m_Phase = phase;
		m_HoldUntil = GetGame().GetTime() + ms;
		m_Frames = 0;
	}

	protected void WriteProgress()
	{
		FileHandle f = OpenFile(m_Prefix + "progress.txt", FileMode.WRITE);
		if (!f) return;
		FPrintln(f, string.Format("%1 %2", m_Plan, m_Point));
		CloseFile(f);
	}

	// Every whole percent: progress, speed and time left.
	protected void Report()
	{
		int total = m_Points.Count();
		int percent = m_Point * 100 / total;
		if (percent == m_LastPercent) return;
		m_LastPercent = percent;
		int done = m_Point - m_StartPoint;
		float seconds = (GetGame().GetTime() - m_Started) / 1000.0;
		float perPoint = seconds / Math.Max(done, 1);
		int left = Math.Round((total - m_Point) * perPoint / 60);
		int now = GetGame().GetTime();
		int fps = Math.Round(m_FrameCount * 1000.0 / Math.Max(now - m_ReportTime, 1));
		m_FrameCount = 0;
		m_ReportTime = now;
		Print(string.Format("[NasdaraCapture] %1 percent (%2 of %3 points), %4 s per point at %5 fps, about %6 h %7 min left", percent, m_Point, total, perPoint, fps, left / 60, left % 60));
	}

	// plan.txt: "key value" settings, then a "points" line, then one "x z" line per point.
	protected bool ReadPlan()
	{
		FileHandle f = OpenFile("$mission:plan.txt", FileMode.READ);
		if (!f)
		{
			Fail("no plan.txt next to init.c (run npm run capture:plan)");
			return false;
		}
		bool points = false;
		string line;
		array<string> parts = new array<string>;
		while (FGets(f, line) > 0) // the plan has no blank lines: an empty line ends the file
		{
			line.TrimInPlace();
			if (line == "" || line.IndexOf("#") == 0) continue;
			parts.Clear();
			line.Split(" ", parts);
			if (points)
			{
				if (parts.Count() >= 2) m_Points.Insert(Vector(parts[0].ToFloat(), 0, parts[1].ToFloat()));
				continue;
			}
			if (parts[0] == "points") points = true;
			else if (parts.Count() >= 2) Setting(parts[0], parts[1]);
		}
		CloseFile(f);
		if (m_Points.Count() == 0)
		{
			Fail("plan.txt has no points");
			return false;
		}
		return true;
	}

	protected void Setting(string key, string value)
	{
		if (key == "plan") m_Plan = value;
		else if (key == "headings") m_Headings = Math.Max(1, value.ToInt());
		else if (key == "fov") m_Fov = value.ToFloat();
		else if (key == "pitch") m_Pitch = value.ToFloat();
		else if (key == "height") m_Height = value.ToFloat();
		else if (key == "first") m_FirstMs = value.ToInt();
		else if (key == "settle") m_SettleMs = value.ToInt();
		else if (key == "turn") m_TurnMs = value.ToInt();
		else if (key == "hour") m_Hour = value.ToInt();
		else if (key == "overcast") m_Overcast = value.ToFloat();
		else if (key == "view") m_View = value.ToFloat();
		else if (key == "stay") m_Stay = value.ToInt() != 0;
	}

	// Where this plan left off: the progress file counts only for the same plan.
	protected int ReadProgress()
	{
		FileHandle f = OpenFile(m_Prefix + "progress.txt", FileMode.READ);
		if (!f) return 0;
		string line;
		FGets(f, line);
		CloseFile(f);
		array<string> parts = new array<string>;
		line.TrimInPlace();
		line.Split(" ", parts);
		if (parts.Count() < 2 || parts[0] != m_Plan) return 0;
		return parts[1].ToInt();
	}

	protected void Finish(string why)
	{
		m_Phase = 4;
		Print("[NasdaraCapture] done: " + why);
		if (m_Stay) return;
		GetGame().RequestExit(0);
	}

	protected void Fail(string why)
	{
		m_Phase = 4;
		Print("[NasdaraCapture] FAILED: " + why);
	}
}

// The game's own offline gameplay mission, minus the player, the HUD and the pause menu.
class NasdaraCaptureMission extends MissionGameplay
{
	protected ref NasdaraCapture m_Capture;

	override void OnMissionStart()
	{
		super.OnMissionStart();
		m_Capture = new NasdaraCapture();
	}

	override void OnUpdate(float timeslice)
	{
		super.OnUpdate(timeslice);
		if (GetHud()) GetHud().ShowHud(false);
		if (m_Capture && !m_Capture.IsDone()) m_Capture.Step();
	}

	// A pause menu would end up in every picture (the game pauses itself when started in the background).
	override void Pause()
	{
	}
}

Mission CreateCustomMission(string path)
{
	return new NasdaraCaptureMission();
}

void main()
{
}
