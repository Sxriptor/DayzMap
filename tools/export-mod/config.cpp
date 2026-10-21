// Server-side only export mod (load with -servermod=@NasdaraExport). Clients never need it.
class CfgPatches
{
	class NasdaraExport
	{
		units[] = {};
		weapons[] = {};
		requiredVersion = 0.1;
		requiredAddons[] = {"DZ_Data", "DZ_Scripts"};
	};
};
class CfgMods
{
	class NasdaraExport
	{
		dir = "NasdaraExport";
		name = "Nasdara Export";
		type = "mod";
		dependencies[] = {"Mission"};
		class defs
		{
			class missionScriptModule
			{
				value = "";
				files[] = {"NasdaraExport/scripts/5_Mission"};
			};
		};
	};
};
