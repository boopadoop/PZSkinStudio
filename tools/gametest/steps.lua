-- Puts the marker skins, and one real skin, on the player and shows them in the game's own
-- character preview panel, large, from the front and the back.
-- See tools/gametest/run.sh.
local panel
local SPECIES = {
    { "SkinStudioBenchTest_MaleWolfNero", "nero" },
    { "SkinStudioBenchTest_MaleDogToki", "toki" },
    { "SkinStudioBenchTest_MaleTigerTigerTwoWild", "tiger" },
    { "XochisCustomBFT_AardMara", "mara" },
}

Bench.add(3, "panel", function()
    local p = getPlayer()
    if FurrySpeciesSelectDialog and FurrySpeciesSelectDialog.instance then
        FurrySpeciesSelectDialog.instance:setVisible(false)
        FurrySpeciesSelectDialog.instance:removeFromUIManager()
    end
    p:clearWornItems()
    Bench.log("species registered:", FurManager.getSpeciesGroupForSpecies("SkinStudioBenchTest_MaleWolfNero") ~= nil)
    FurManager.changePlayerSpecies(p, SPECIES[1][1])
    local fur = FurManager.getPlayerWornFur(p)
    Bench.log("worn:", fur and fur:getFullType())
    panel = ISUI3DModel:new(240, 0, 800, 720)
    panel:initialise()
    panel:instantiate()
    panel:addToUIManager()
    panel:setVisible(true)
    panel:bringToTop()
    panel:setState("idle")
    panel:setIsometric(false)
    panel:setDirection(IsoDirections.S)
    panel:setCharacter(p)
    panel:setZoom(14)
    panel:setYOffset(-0.9)
end)

for _, s in ipairs(SPECIES) do
    Bench.add(3, "wear " .. s[2], function()
        local p = getPlayer()
        FurManager.changePlayerSpecies(p, s[1])
        local fur = FurManager.getPlayerWornFur(p)
        Bench.log("worn:", fur and fur:getFullType(), "female", p:isFemale())
        panel:setCharacter(p)
        panel:setDirection(IsoDirections.S)
    end)
    Bench.add(2, s[2] .. " front", function() Bench.shot(s[2] .. "_front") end)
    Bench.add(2, "turn", function() panel:setDirection(IsoDirections.N) end)
    Bench.add(2, s[2] .. " back", function() Bench.shot(s[2] .. "_back") end)
end
-- What the base mod does when the character dies: this is why a skin needs a _Deceased item.
Bench.add(2, "death swap", function()
    local p = getPlayer()
    FurManager.changePlayerSpecies(p, SPECIES[1][1])
    FurManager.swapPlayerFurClothingToDeceased(p)
    local items = p:getInventory():getItems()
    for i = 0, items:size() - 1 do
        local item = items:get(i)
        if string.find(item:getFullType(), "SkinStudioBenchTest", 1, true) then
            Bench.log("after the swap:", item:getFullType(), "worn", p:isEquippedClothing(item))
        end
    end
end)
Bench.add(1, "end", Bench.done)
