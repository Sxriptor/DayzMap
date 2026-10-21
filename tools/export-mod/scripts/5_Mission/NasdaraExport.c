// When the server starts, sweeps the whole map in overlapping circles and writes every power pole, pylon,
// wire and sign it finds to $profile:nasdara_objects.json (one JSON object per line), plus a count of every
// model seen to $profile:nasdara_shapes.txt so the filter can be checked. Read by `npm run build:nasdara`.
class NasdaraExport
{
	static const float WORLD = 16384;
	static const float STEP = 200;
	static const float RADIUS = 145; // just over STEP * 0.707, so the circles cover every grid cell

	// Model names worth keeping: power infrastructure and signs.
	static bool Wanted(string shape)
	{
		return shape.Contains("power") || shape.Contains("pylon") || shape.Contains("sign") || shape.Contains("billboard");
	}

	static void Run()
	{
		Print("[NasdaraExport] sweeping the map...");
		FileHandle out = OpenFile("$profile:nasdara_objects.json", FileMode.WRITE);
		if (!out) { Print("[NasdaraExport] cannot write $profile:nasdara_objects.json"); return; }
		map<string, int> seen = new map<string, int>;   // dedupe key -> 1 (circles overlap)
		map<string, int> shapes = new map<string, int>; // model -> count, for checking the filter
		array<Object> objects = new array<Object>;
		array<CargoBase> cargos = new array<CargoBase>;
		int kept = 0;
		for (float x = STEP / 2; x < WORLD; x += STEP)
		{
			for (float z = STEP / 2; z < WORLD; z += STEP)
			{
				objects.Clear(); cargos.Clear();
				GetGame().GetObjectsAtPosition(Vector(x, GetGame().SurfaceY(x, z), z), RADIUS, objects, cargos);
				foreach (Object obj : objects)
				{
					if (!obj) continue;
					string shape = obj.GetShapeName();
					shape.ToLower();
					shape.Replace("\\", "/");
					if (shape == "") shape = obj.GetType();
					vector p = obj.GetPosition();
					string key = shape + "@" + Math.Round(p[0] * 10).ToString() + "," + Math.Round(p[2] * 10).ToString();
					if (seen.Contains(key)) continue;
					seen.Insert(key, 1);
					shapes.Set(shape, shapes.Get(shape) + 1);
					if (!Wanted(shape)) continue;
					vector o = obj.GetOrientation();
					FPrintln(out, string.Format("{\"m\":\"%1\",\"x\":%2,\"y\":%3,\"z\":%4,\"yaw\":%5,\"pitch\":%6,\"roll\":%7}",
						shape, p[0], p[1], p[2], o[0], o[1], o[2]));
					kept++;
				}
			}
		}
		CloseFile(out);
		FileHandle list = OpenFile("$profile:nasdara_shapes.txt", FileMode.WRITE);
		if (list)
		{
			foreach (string name, int count : shapes) FPrintln(list, count.ToString() + "\t" + name);
			CloseFile(list);
		}
		Print("[NasdaraExport] done: " + kept.ToString() + " objects kept, " + shapes.Count().ToString() + " model types seen");
	}
}

modded class MissionServer
{
	override void OnInit()
	{
		super.OnInit();
		NasdaraExport.Run();
	}
}
