// Server-side export of everything about the running world that the offline map cannot read from unencrypted
// files. When the server starts it works through four stages, a slice per server frame so the server never
// hangs, and writes into $profile:NasdaraExport\ (copy that folder's files into the project's exports\<world>\
// folder, then run `npm run build:map -- <world>`). Any world works; every file is prefixed with the world name
// in lower case (nasdara_, chernarusplus_, sakhal_ ...), written <world>_ below:
//   <world>_world.json         world name, size and every named place (towns, villages, hills, bays...)
//   <world>_objects.json       every static object except vegetation, one JSON object per line: model, class,
//                              kind (b building, r rock, o other), use (water, fuel), position, orientation
//                              and model-space box
//   <world>_vegetation.txt     every tree (T) and bush (B): "kind x z model", models in <world>_vegetation_models.txt
//   <world>_terrain.txt        every 10 m: height (cm), ground surface and water (0 land, 1 sea, 2 pond)
//   <world>_roadway.txt        every 4 m where something walkable lies on the ground (roads, floors, bridges):
//                              "column row surface lift(cm)"; surfaces for both files in <world>_surfaces.txt
//   <world>_shapes.txt         a count of every non-vegetation model, to check the map's filters
//   <world>_done.txt           written last, with totals
// The server shuts itself down when finished unless started with -nasdaraStay.
class NasdaraExport
{
	static const string DIR = "$profile:NasdaraExport";
	static const float SWEEP_STEP = 100;   // one object query per 100 m cell...
	static const float SWEEP_RADIUS = 100; // ...reaching well past its corners (70.7 m), with room for slopes
	static const float TERRAIN_STEP = 10;
	static const float ROADWAY_STEP = 4;
	static const int SWEEP_PER_FRAME = 6;
	static const int TERRAIN_ROWS_PER_FRAME = 2;
	static const int ROADWAY_ROWS_PER_FRAME = 1;

	protected int m_Stage; // 0 places, 1 objects, 2 terrain, 3 roadway, 4 done
	protected int m_Row;
	protected int m_Col;
	protected int m_Cells;
	protected int m_LastTenth;
	protected int m_StageStart;
	protected float m_Size;
	protected string m_World;
	protected string m_Prefix; // output file prefix: DIR/<world in lower case>_
	protected FileHandle m_Out;
	protected FileHandle m_Veg;
	protected string m_Buf;
	protected int m_BufCount;
	protected int m_Places;
	protected int m_Kept;
	protected int m_Trees;
	protected int m_Bushes;
	protected int m_RoadCells;
	protected ref map<string, int> m_Shapes;
	protected ref map<string, int> m_VegModels;
	protected ref map<string, int> m_Surfaces;
	protected ref array<Object> m_Objects;
	protected ref array<CargoBase> m_Cargos;
	protected ref array<int> m_RowSurfaces;

	void NasdaraExport()
	{
		m_Shapes = new map<string, int>;
		m_VegModels = new map<string, int>;
		m_Surfaces = new map<string, int>;
		m_Objects = new array<Object>;
		m_Cargos = new array<CargoBase>;
		m_RowSurfaces = new array<int>;
		MakeDirectory(DIR);
		Print("[NasdaraExport] starting; output in " + DIR);
	}

	bool IsDone()
	{
		return m_Stage >= 4;
	}

	void Step()
	{
		if (m_Stage == 0) WritePlaces();
		else if (m_Stage == 1) SweepObjects();
		else if (m_Stage == 2) SampleTerrain();
		else if (m_Stage == 3) SampleRoadway();
	}

	// Stage 0: world size and the named places from the world config (what the in-game map labels come from).
	protected void WritePlaces()
	{
		GetGame().GetWorldName(m_World);
		string lower = m_World;
		lower.ToLower();
		m_Prefix = DIR + "/" + lower + "_";
		string cfg = "CfgWorlds " + m_World;
		m_Size = GetGame().GetWorld().GetWorldSize();
		if (m_Size < 1000 && GetGame().ConfigIsExisting(cfg + " mapSize")) m_Size = GetGame().ConfigGetFloat(cfg + " mapSize");
		if (m_Size < 1000) m_Size = 16384;
		FileHandle f = OpenFile(m_Prefix + "world.json", FileMode.WRITE);
		if (!f)
		{
			Fail("cannot write " + m_Prefix + "world.json");
			return;
		}
		FPrint(f, string.Format("{\"world\":\"%1\",\"size\":%2,\"places\":[", Esc(m_World), m_Size));
		string names = cfg + " Names";
		int count = GetGame().ConfigGetChildrenCount(names);
		for (int i = 0; i < count; i++)
		{
			string cls;
			GetGame().ConfigGetChildName(names, i, cls);
			string path = names + " " + cls;
			TFloatArray pos = new TFloatArray;
			GetGame().ConfigGetFloatArray(path + " position", pos);
			if (pos.Count() < 2) continue;
			string name;
			string type;
			GetGame().ConfigGetText(path + " name", name);
			GetGame().ConfigGetText(path + " type", type);
			float ra = GetGame().ConfigGetFloat(path + " radiusA");
			float rb = GetGame().ConfigGetFloat(path + " radiusB");
			float angle = GetGame().ConfigGetFloat(path + " angle");
			if (m_Places > 0) FPrint(f, ",");
			FPrint(f, string.Format("{\"cls\":\"%1\",\"name\":\"%2\",\"type\":\"%3\",", Esc(cls), Esc(name), Esc(type)));
			FPrint(f, string.Format("\"x\":%1,\"z\":%2,\"ra\":%3,\"rb\":%4,\"angle\":%5}", pos[0], pos[1], ra, rb, angle));
			m_Places++;
		}
		FPrintln(f, "]}");
		CloseFile(f);
		Print("[NasdaraExport] world " + m_World + ", size " + m_Size.ToString() + ", " + m_Places.ToString() + " named places");

		m_Out = OpenFile(m_Prefix + "objects.json", FileMode.WRITE);
		m_Veg = OpenFile(m_Prefix + "vegetation.txt", FileMode.WRITE);
		if (!m_Out || !m_Veg)
		{
			Fail("cannot write the object files");
			return;
		}
		Begin(1, Math.Ceil(m_Size / SWEEP_STEP));
	}

	// Stage 1: every object, one query per cell. An object belongs to the cell its position falls in, so the
	// overlapping queries never write it twice.
	protected void SweepObjects()
	{
		for (int n = 0; n < SWEEP_PER_FRAME && m_Stage == 1; n++)
		{
			float x0 = m_Col * SWEEP_STEP;
			float z0 = m_Row * SWEEP_STEP;
			float cx = x0 + SWEEP_STEP / 2;
			float cz = z0 + SWEEP_STEP / 2;
			m_Objects.Clear();
			m_Cargos.Clear();
			GetGame().GetObjectsAtPosition(Vector(cx, GetGame().SurfaceY(cx, cz), cz), SWEEP_RADIUS, m_Objects, m_Cargos);
			foreach (Object obj : m_Objects)
			{
				if (!obj) continue;
				vector p = obj.GetPosition();
				if (p[0] < x0 || p[0] >= x0 + SWEEP_STEP || p[2] < z0 || p[2] >= z0 + SWEEP_STEP) continue;
				if (Skip(obj)) continue;
				WriteObject(obj, p);
			}
			m_Col++;
			if (m_Col < m_Cells) continue;
			m_Col = 0;
			m_Row++;
			Progress("objects");
			if (m_Row < m_Cells) continue;
			CloseFile(m_Out);
			CloseFile(m_Veg);
			WriteTable("vegetation_models.txt", m_VegModels);
			Print("[NasdaraExport] objects: " + m_Kept.ToString() + " kept, " + m_Trees.ToString() + " trees, " + m_Bushes.ToString() + " bushes");
			m_Out = OpenFile(m_Prefix + "terrain.txt", FileMode.WRITE);
			if (!m_Out)
			{
				Fail("cannot write " + m_Prefix + "terrain.txt");
				return;
			}
			FPrintln(m_Out, string.Format("# step %1 cells %2 rows from south: row|heights cm|surfaces|water", TERRAIN_STEP, Math.Ceil(m_Size / TERRAIN_STEP)));
			Begin(2, Math.Ceil(m_Size / TERRAIN_STEP));
		}
	}

	// Things that are not part of the map: loot, vehicles, players, animals, infected, event wrecks and
	// script-made areas and triggers.
	protected bool Skip(Object obj)
	{
		if (obj.IsInherited(ItemBase) || obj.IsInherited(Transport) || obj.IsInherited(Man) || obj.IsInherited(DayZCreature)) return true;
		if (obj.IsInherited(EffectArea) || obj.IsInherited(ScriptedEntity)) return true;
		string type = obj.GetType();
		return type.IndexOf("Wreck_") == 0;
	}

	protected void WriteObject(Object obj, vector p)
	{
		string type = obj.GetType();
		string shape = obj.GetShapeName();
		shape.ToLower();
		shape.Replace("\\", "/");
		if (shape == "") shape = type;
		if (shape.IndexOf("#") == 0) return; // engine helpers such as #animator, all at 0, 0
		if (obj.IsTree() || obj.IsBush())
		{
			if (!m_VegModels.Contains(shape)) m_VegModels.Insert(shape, m_VegModels.Count());
			string plant = "B";
			if (obj.IsTree())
			{
				plant = "T";
				m_Trees++;
			}
			else m_Bushes++;
			FPrintln(m_Veg, string.Format("%1 %2 %3 %4", plant, p[0], p[2], m_VegModels.Get(shape)));
			return;
		}
		m_Shapes.Set(shape, m_Shapes.Get(shape) + 1);
		string kind = "o";
		if (obj.IsBuilding()) kind = "b";
		else if (obj.IsRock()) kind = "r";
		// What the game itself lets players use the object for: drinking water, refuelling.
		string use = "";
		if (obj.GetWaterSourceObjectType() != EWaterSourceObjectType.NONE) use = "water";
		else if (obj.IsFuelStation() || obj.GetLiquidSourceObjectType() != ELiquidSourceObjectType.NONE) use = "fuel";
		vector box[2];
		if (!obj.GetCollisionBox(box)) obj.ClippingInfo(box);
		vector lo = box[0];
		vector hi = box[1];
		vector o = obj.GetOrientation();
		FPrint(m_Out, string.Format("{\"m\":\"%1\",\"t\":\"%2\",\"k\":\"%3\",\"x\":%4,\"y\":%5,\"z\":%6,", Esc(shape), Esc(type), kind, p[0], p[1], p[2]));
		FPrint(m_Out, string.Format("\"yaw\":%1,\"pitch\":%2,\"roll\":%3,\"u\":\"%4\",", o[0], o[1], o[2], use));
		FPrintln(m_Out, string.Format("\"b\":[%1,%2,%3,%4,%5,%6]}", lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]));
		m_Kept++;
	}

	// Stage 2: one line per 10 m row (from the south): row|height cm,...|surface,...|water digits.
	protected void SampleTerrain()
	{
		for (int r = 0; r < TERRAIN_ROWS_PER_FRAME && m_Stage == 2; r++)
		{
			float z = (m_Row + 0.5) * TERRAIN_STEP;
			string water = "";
			m_RowSurfaces.Clear();
			FPrint(m_Out, m_Row.ToString() + "|");
			for (int ix = 0; ix < m_Cells; ix++)
			{
				float x = (ix + 0.5) * TERRAIN_STEP;
				int cm = Math.Round(GetGame().SurfaceY(x, z) * 100);
				string ground;
				GetGame().SurfaceGetType(x, z, ground);
				m_RowSurfaces.Insert(SurfaceIndex(ground));
				if (GetGame().SurfaceIsSea(x, z)) water += "1";
				else if (GetGame().SurfaceIsPond(x, z)) water += "2";
				else water += "0";
				if (ix > 0) Put(",");
				Put(cm.ToString());
			}
			Put("|");
			for (int i = 0; i < m_RowSurfaces.Count(); i++)
			{
				if (i > 0) Put(",");
				Put(m_RowSurfaces[i].ToString());
			}
			Flush();
			FPrintln(m_Out, "|" + water);
			m_Row++;
			Progress("terrain");
			if (m_Row < m_Cells) continue;
			CloseFile(m_Out);
			m_Out = OpenFile(m_Prefix + "roadway.txt", FileMode.WRITE);
			if (!m_Out)
			{
				Fail("cannot write " + m_Prefix + "roadway.txt");
				return;
			}
			FPrintln(m_Out, string.Format("# step %1 cells %2: column row surface lift_cm (rows from south)", ROADWAY_STEP, Math.Ceil(m_Size / ROADWAY_STEP)));
			Begin(3, Math.Ceil(m_Size / ROADWAY_STEP));
		}
	}

	// Stage 3: every 4 m, the surface met coming down from just above the ground (or above the road surface,
	// for bridges). Only cells where that differs from the bare ground are written: roads, floors, platforms.
	protected void SampleRoadway()
	{
		float sea = GetGame().SurfaceGetSeaLevel();
		for (int r = 0; r < ROADWAY_ROWS_PER_FRAME && m_Stage == 3; r++)
		{
			float z = (m_Row + 0.5) * ROADWAY_STEP;
			for (int ix = 0; ix < m_Cells; ix++)
			{
				float x = (ix + 0.5) * ROADWAY_STEP;
				float ground = GetGame().SurfaceY(x, z);
				if (ground < sea - 1) continue;
				float road = GetGame().SurfaceRoadY(x, z);
				string below;
				string top;
				GetGame().SurfaceGetType(x, z, below);
				GetGame().SurfaceGetType3D(x, Math.Max(ground, road) + 0.3, z, top);
				if (top == "" || top == below) continue;
				int lift = Math.Round((road - ground) * 100);
				FPrintln(m_Out, string.Format("%1 %2 %3 %4", ix, m_Row, SurfaceIndex(top), lift));
				m_RoadCells++;
			}
			m_Row++;
			Progress("roadway");
			if (m_Row < m_Cells) continue;
			CloseFile(m_Out);
			Finish();
		}
	}

	protected void Finish()
	{
		WriteTable("surfaces.txt", m_Surfaces);
		FileHandle list = OpenFile(m_Prefix + "shapes.txt", FileMode.WRITE);
		if (list)
		{
			foreach (string name, int count : m_Shapes) FPrintln(list, count.ToString() + "\t" + name);
			CloseFile(list);
		}
		string summary = string.Format("world %1, places %2, objects %3, model types %4, trees %5, bushes %6, surfaces %7, roadway cells %8",
			m_World, m_Places, m_Kept, m_Shapes.Count(), m_Trees, m_Bushes, m_Surfaces.Count(), m_RoadCells);
		FileHandle done = OpenFile(m_Prefix + "done.txt", FileMode.WRITE);
		if (done)
		{
			FPrintln(done, summary);
			CloseFile(done);
		}
		m_Stage = 4;
		Print("[NasdaraExport] done: " + summary);
		string stay;
		if (GetCLIParam("nasdaraStay", stay)) return;
		Print("[NasdaraExport] shutting the server down (start with -nasdaraStay to keep it running)");
		GetGame().RequestExit(0);
	}

	protected void Begin(int stage, int cells)
	{
		m_Stage = stage;
		m_Cells = cells;
		m_Row = 0;
		m_Col = 0;
		m_LastTenth = 0;
		m_StageStart = GetGame().GetTime();
	}

	protected void Progress(string what)
	{
		int tenth = m_Row * 10 / m_Cells;
		if (tenth == m_LastTenth) return;
		m_LastTenth = tenth;
		int seconds = (GetGame().GetTime() - m_StageStart) / 1000;
		Print("[NasdaraExport] " + what + " " + (tenth * 10).ToString() + "% (" + seconds.ToString() + " s)");
	}

	protected void Fail(string why)
	{
		Print("[NasdaraExport] FAILED: " + why);
		m_Stage = 4;
	}

	protected int SurfaceIndex(string name)
	{
		if (!m_Surfaces.Contains(name)) m_Surfaces.Insert(name, m_Surfaces.Count());
		return m_Surfaces.Get(name);
	}

	// Long rows go out in chunks: building one huge string costs far more than a few writes.
	protected void Put(string s)
	{
		m_Buf += s;
		m_BufCount++;
		if (m_BufCount >= 200) Flush();
	}

	protected void Flush()
	{
		if (m_Buf != "") FPrint(m_Out, m_Buf);
		m_Buf = "";
		m_BufCount = 0;
	}

	protected void WriteTable(string file, map<string, int> table)
	{
		FileHandle f = OpenFile(m_Prefix + file, FileMode.WRITE);
		if (!f) return;
		foreach (string name, int index : table) FPrintln(f, index.ToString() + "\t" + name);
		CloseFile(f);
	}

	static string Esc(string s)
	{
		s.Replace("\\", "\\\\");
		s.Replace("\"", "\\\"");
		return s;
	}
}

modded class MissionServer
{
	protected ref NasdaraExport m_NasdaraExport;

	override void OnInit()
	{
		super.OnInit();
		m_NasdaraExport = new NasdaraExport();
	}

	override void OnUpdate(float timeslice)
	{
		super.OnUpdate(timeslice);
		if (m_NasdaraExport && !m_NasdaraExport.IsDone()) m_NasdaraExport.Step();
	}
}
