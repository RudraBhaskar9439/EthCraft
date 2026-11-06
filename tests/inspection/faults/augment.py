"""Derive the isolated sealed-fault fixture from the unchanged boundary fixture."""

from pathlib import Path


def generate(original: Path, extension: Path, recovery: Path, destination: Path):
    source = original.read_text()
    substitutions = [
        ('public final class WorldFixture extends JavaPlugin implements Listener {',
         'public final class FaultFixture extends JavaPlugin implements Listener {'),
        ('world.save();Files.writeString(root.resolve("fixture-initialized")',
         'bootstrapFault();world.save();Files.writeString(root.resolve("fixture-initialized")'),
        ('Bukkit.getScheduler().runTaskTimerAsynchronously(this,this::modeFault,5,5);',
         'Bukkit.getScheduler().runTaskTimer(this,this::sealedFaultTick,1,1);'),
        ('p.teleport(spawn);', 'p.teleport(spawn);faultJoin(p);'),
        ('private void snapshot() {\n        if(failed)return;',
         'private void snapshot() {\n        if(failed||faultChunkFreeze)return;'),
        ('    @Override public void onDisable()', extension.read_text() + '\n' + recovery.read_text() + '\n    @Override public void onDisable()'),
    ]
    for before, after in substitutions:
        if source.count(before) != 1:
            raise ValueError('Boundary fixture changed; sealed augmentation anchor is ambiguous: ' + before[:90])
        source = source.replace(before, after, 1)
    destination.write_text(source)
