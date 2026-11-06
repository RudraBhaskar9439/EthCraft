package org.agentcity.paper;

import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.*;
import org.bukkit.event.entity.*;
import org.bukkit.event.inventory.*;
import org.bukkit.event.player.*;
import org.bukkit.event.world.*;
import org.bukkit.event.weather.LightningStrikeEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.Location;

/** All supported structural mutation paths cross the same receiving boundary. */
final class PlotProtection implements Listener {
    interface Authority {
        boolean place(BlockPlaceEvent event);
        boolean remove(BlockBreakEvent event);
        boolean input(PlayerInteractEvent event);
        boolean open(InventoryOpenEvent event);
        boolean registered(Player player);
        void unavailable(String reason);
        void refused(String reason);
    }
    private final World world;
    private final int[] min, max;
    private final Authority authority;

    PlotProtection(World world, int[] min, int[] max, Authority authority) {
        this.world = world; this.min = min.clone(); this.max = max.clone(); this.authority = authority;
    }
    boolean inside(Location p, int margin) {
        return p.getWorld().equals(world) && p.getBlockX() >= min[0]-margin && p.getBlockX() <= max[0]+margin
            && p.getBlockY() >= min[1]-margin && p.getBlockY() <= max[1]+margin
            && p.getBlockZ() >= min[2]-margin && p.getBlockZ() <= max[2]+margin;
    }
    boolean guard(Block b) { return inside(b.getLocation(), 1); }
    private boolean stock(Inventory inventory) {
        return inventory.getLocation() != null && inside(inventory.getLocation(), 1);
    }
    private void deny(org.bukkit.event.Cancellable event, String reason) {
        event.setCancelled(true); authority.refused(reason);
    }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void place(BlockPlaceEvent e) {
        if ((guard(e.getBlock()) || authority.registered(e.getPlayer())) && !authority.place(e)) deny(e,"placement_not_authorized");
    }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void remove(BlockBreakEvent e) {
        if ((guard(e.getBlock()) || authority.registered(e.getPlayer())) && !authority.remove(e)) deny(e,"break_not_authorized");
    }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void interact(PlayerInteractEvent e) {
        if (e.getClickedBlock()!=null && guard(e.getClickedBlock()) && !authority.input(e)) deny(e,"interaction_not_authorized");
    }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void open(InventoryOpenEvent e) {
        if (stock(e.getInventory()) && !authority.open(e)) deny(e,"stock_open_not_authorized");
    }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void click(InventoryClickEvent e) {
        // Job transfers use the bounded receipted transfer API, including assigned actors.
        if (stock(e.getView().getTopInventory())) deny(e,"stock_native_transfer_disabled");
    }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void drag(InventoryDragEvent e) { if (stock(e.getView().getTopInventory())) deny(e,"stock_drag_disabled"); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void move(InventoryMoveItemEvent e) { if (stock(e.getSource()) || stock(e.getDestination())) deny(e,"stock_automation_disabled"); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void pickup(InventoryPickupItemEvent e) { if (stock(e.getInventory())) deny(e,"stock_automation_disabled"); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void bucket(PlayerBucketEmptyEvent e) {if(guard(e.getBlock())||guard(e.getBlockClicked())||guard(e.getBlockClicked().getRelative(e.getBlockFace())))deny(e,"bucket_empty_disabled");}
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void bucket(PlayerBucketFillEvent e) {if(guard(e.getBlock())||guard(e.getBlockClicked())||guard(e.getBlockClicked().getRelative(e.getBlockFace())))deny(e,"bucket_fill_disabled");}
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void dispense(BlockDispenseEvent e) {if(guard(e.getBlock()))deny(e,"dispenser_disabled");}
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void creative(InventoryCreativeEvent e) {if(e.getWhoClicked() instanceof Player p && authority.registered(p))deny(e,"creative_inventory_disabled");}
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void piston(BlockPistonExtendEvent e) {
        if (guard(e.getBlock()) || e.getBlocks().stream().anyMatch(b->guard(b)||guard(b.getRelative(e.getDirection())))) deny(e,"piston_disabled");
    }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void piston(BlockPistonRetractEvent e) {
        if (guard(e.getBlock()) || e.getBlocks().stream().anyMatch(b->guard(b)||guard(b.getRelative(e.getDirection().getOppositeFace())))) deny(e,"piston_disabled");
    }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void explosion(EntityExplodeEvent e) { if (inside(e.getLocation(),1)||e.blockList().stream().anyMatch(this::guard)) deny(e,"explosion_disabled"); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void explosion(BlockExplodeEvent e) { if (guard(e.getBlock())||e.blockList().stream().anyMatch(this::guard)) deny(e,"explosion_disabled"); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void ignite(BlockIgniteEvent e) { if (guard(e.getBlock())) deny(e,"fire_disabled"); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void burn(BlockBurnEvent e) { if (guard(e.getBlock())) deny(e,"fire_disabled"); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void spread(BlockSpreadEvent e) { if (guard(e.getBlock())||guard(e.getSource())) deny(e,"spread_disabled"); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void flow(BlockFromToEvent e) { if (guard(e.getBlock())||guard(e.getToBlock())) deny(e,"fluid_disabled"); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void entity(EntityChangeBlockEvent e) { if (guard(e.getBlock())||inside(e.getEntity().getLocation(),1)) deny(e,"entity_block_change_disabled"); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void form(BlockFormEvent e) { if (guard(e.getBlock())) deny(e,"block_form_disabled"); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void fade(BlockFadeEvent e) { if (guard(e.getBlock())) deny(e,"block_fade_disabled"); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void grow(BlockGrowEvent e) { if (guard(e.getBlock())) deny(e,"block_grow_disabled"); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void decay(LeavesDecayEvent e) { if (guard(e.getBlock())) deny(e,"decay_disabled"); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void fertilize(BlockFertilizeEvent e) { if (guard(e.getBlock())||e.getBlocks().stream().anyMatch(b->guard(b.getBlock()))) deny(e,"fertilize_disabled"); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void tree(StructureGrowEvent e) { if (inside(e.getLocation(),1)||e.getBlocks().stream().anyMatch(b->guard(b.getBlock()))) deny(e,"structure_growth_disabled"); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void portal(PortalCreateEvent e) { if (e.getBlocks().stream().anyMatch(b->guard(b.getBlock()))) deny(e,"portal_creation_disabled"); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void lightning(LightningStrikeEvent e) { if (inside(e.getLightning().getLocation(),1)) deny(e,"lightning_disabled"); }
    @EventHandler public void unload(ChunkUnloadEvent e) {
        if (e.getWorld().equals(world) && e.getChunk().getX() >= (min[0]>>4) && e.getChunk().getX() <= (max[0]>>4)
                && e.getChunk().getZ() >= (min[2]>>4) && e.getChunk().getZ() <= (max[2]>>4)) authority.unavailable("plot_chunk_unloaded");
    }
    @EventHandler public void unload(WorldUnloadEvent e) { if (e.getWorld().equals(world)) authority.unavailable("world_unloaded"); }
}
